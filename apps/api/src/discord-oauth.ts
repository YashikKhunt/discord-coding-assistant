const DISCORD_API = "https://discord.com/api/v10";

export interface DiscordIdentity {
  id: string;
  username: string;
  globalName: string | null;
  avatar: string | null;
  /** Role IDs in the configured guild; empty if the user is not a member. */
  roles: string[];
  inGuild: boolean;
}

export interface DiscordOAuth {
  authorizeUrl(state: string): string;
  /** Exchanges an authorization code and loads the user plus their roles in the guild. */
  identify(code: string): Promise<DiscordIdentity>;
}

export class DiscordOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscordOAuthError";
  }
}

export interface DiscordOAuthOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  guildId: string;
  fetch?: typeof fetch;
}

export function createDiscordOAuth(options: DiscordOAuthOptions): DiscordOAuth {
  const doFetch = options.fetch ?? fetch;

  async function getJson<T>(
    path: string,
    accessToken: string,
  ): Promise<{ status: number; body: T | null }> {
    const res = await doFetch(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw new DiscordOAuthError(`Discord ${path} failed with ${res.status}`);
    return { status: res.status, body: (await res.json()) as T };
  }

  return {
    authorizeUrl(state) {
      const params = new URLSearchParams({
        client_id: options.clientId,
        response_type: "code",
        redirect_uri: options.redirectUri,
        scope: "identify guilds.members.read",
        state,
        prompt: "none",
      });
      return `https://discord.com/oauth2/authorize?${params}`;
    },

    async identify(code) {
      const tokenRes = await doFetch(`${DISCORD_API}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: options.redirectUri,
          client_id: options.clientId,
          client_secret: options.clientSecret,
        }),
      });
      if (!tokenRes.ok) {
        throw new DiscordOAuthError(`Discord token exchange failed with ${tokenRes.status}`);
      }
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!token.access_token) throw new DiscordOAuthError("Discord returned no access token");

      const user = await getJson<{
        id: string;
        username: string;
        global_name: string | null;
        avatar: string | null;
      }>("/users/@me", token.access_token);
      if (!user.body) throw new DiscordOAuthError("Discord user not found");

      const member = await getJson<{ roles: string[] }>(
        `/users/@me/guilds/${options.guildId}/member`,
        token.access_token,
      );

      // The access token is only used for these two reads; it is not stored.
      return {
        id: user.body.id,
        username: user.body.username,
        globalName: user.body.global_name,
        avatar: user.body.avatar,
        roles: member.body?.roles ?? [],
        inGuild: member.body !== null,
      };
    },
  };
}
