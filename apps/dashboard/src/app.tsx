import { useEffect, useState } from "react";
import { api, type Me } from "./api.ts";
import { Meter } from "./components/charts.tsx";
import { usd } from "./format.ts";
import { useResource } from "./hooks.ts";
import { CostsPage } from "./pages/costs.tsx";
import { JobDetailPage } from "./pages/job-detail.tsx";
import { JobsPage } from "./pages/jobs.tsx";
import { NewJobPage } from "./pages/new-job.tsx";
import { Link, navigate, useLocation, useTitle } from "./router.tsx";

const LOGIN_ERRORS: Record<string, string> = {
  forbidden: "Your Discord account is not on the allowlist for this agent.",
  state: "The sign-in link expired. Try again.",
  discord: "Discord did not complete the sign-in. Try again.",
  internal: "Something went wrong while signing in.",
};

function LoginPage() {
  useTitle("Sign in");
  const error = new URL(location.href).searchParams.get("error");
  return (
    <main className="login">
      <div className="card login-card">
        <span className="wordmark" style={{ padding: 0 }}>
          <span className="wordmark-glyph" aria-hidden="true">
            &gt;_
          </span>
          discord-coding-agent
        </span>
        <h1>Agent console</h1>
        <p className="secondary" style={{ margin: 0 }}>
          Watch jobs, read every step the agent took, and keep an eye on spend.
        </p>
        {error && (
          <div className="error-box" role="alert" style={{ marginTop: 18 }}>
            {LOGIN_ERRORS[error] ?? LOGIN_ERRORS.internal}
          </div>
        )}
        <a className="button discord-button" href="/auth/discord/login">
          <svg width="18" height="14" viewBox="0 0 71 55" aria-hidden="true">
            <path
              fill="currentColor"
              d="M60.1 4.9A58.5 58.5 0 0 0 45.6.4a.2.2 0 0 0-.2.1 40.8 40.8 0 0 0-1.8 3.7 54 54 0 0 0-16.2 0A37.4 37.4 0 0 0 25.5.5a.2.2 0 0 0-.2-.1A58.4 58.4 0 0 0 10.8 4.9a.2.2 0 0 0-.1.1C1.6 18.7-.9 32.2.3 45.5a.2.2 0 0 0 .1.2 58.8 58.8 0 0 0 17.7 9 .2.2 0 0 0 .3-.1 42 42 0 0 0 3.6-5.9.2.2 0 0 0-.1-.3 38.7 38.7 0 0 1-5.5-2.6.2.2 0 0 1 0-.4l1.1-.9a.2.2 0 0 1 .2 0 42 42 0 0 0 35.6 0 .2.2 0 0 1 .2 0l1.1.9a.2.2 0 0 1 0 .4 36.3 36.3 0 0 1-5.5 2.6.2.2 0 0 0-.1.3 47.2 47.2 0 0 0 3.6 5.9.2.2 0 0 0 .3.1 58.6 58.6 0 0 0 17.8-9 .2.2 0 0 0 .1-.2c1.5-15.4-2.5-28.8-10.5-40.6a.2.2 0 0 0-.1-.1zM23.7 37.3c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2zm23.6 0c-3.5 0-6.4-3.2-6.4-7.2s2.8-7.2 6.4-7.2 6.5 3.3 6.4 7.2c0 4-2.8 7.2-6.4 7.2z"
            />
          </svg>
          Sign in with Discord
        </a>
      </div>
    </main>
  );
}

function Rail({ me, path }: { me: Me; path: string }) {
  const { data: costs } = useResource(() => api.costs(30), "rail", { refreshMs: 60_000 });
  const nav = [
    { href: "/", label: "Jobs", key: "g j", active: path === "/" || path.startsWith("/jobs") },
    { href: "/new", label: "New job", key: "n", active: path === "/new" },
    { href: "/costs", label: "Costs", key: "g c", active: path === "/costs" },
  ];
  const logout = async () => {
    await api.logout().catch(() => {});
    location.assign("/login");
  };
  return (
    <nav className="rail" aria-label="Main">
      <Link className="wordmark" href="/">
        <span className="wordmark-glyph" aria-hidden="true">
          &gt;_
        </span>
        agent console
      </Link>
      <div className="nav">
        {nav.map((item) => (
          <Link key={item.href} href={item.href} aria-current={item.active ? "page" : undefined}>
            {item.label}
            <kbd>{item.key}</kbd>
          </Link>
        ))}
      </div>
      <div className="rail-foot">
        {costs && (
          <div className="budget">
            <div className="budget-row">
              <span>Monthly LLM budget</span>
            </div>
            <Meter
              value={costs.monthSpendUsd}
              max={costs.monthlyCapUsd}
              label="Monthly spend against cap"
            />
            <div className="budget-row">
              <span className="num">{usd(costs.monthSpendUsd)}</span>
              <span className="num">{usd(costs.monthlyCapUsd, 0)}</span>
            </div>
          </div>
        )}
        <div className="user">
          {me.avatarUrl ? <img src={me.avatarUrl} alt="" /> : <span className="avatar-fallback" />}
          <span>{me.username}</span>
          <button type="button" className="link-button" onClick={logout}>
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}

function useShortcuts() {
  useEffect(() => {
    let pendingG = false;
    let timer: ReturnType<typeof setTimeout>;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target.closest("input, textarea, select")
      )
        return;
      if (pendingG) {
        pendingG = false;
        if (event.key === "j") navigate("/");
        if (event.key === "c") navigate("/costs");
        return;
      }
      if (event.key === "g") {
        pendingG = true;
        clearTimeout(timer);
        timer = setTimeout(() => {
          pendingG = false;
        }, 800);
      } else if (event.key === "n") {
        navigate("/new");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const url = useLocation();
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  useShortcuts();

  useEffect(() => {
    if (url.pathname === "/login") {
      setChecked(true);
      return;
    }
    api
      .me()
      .then(setMe)
      .catch(() => {})
      .finally(() => setChecked(true));
  }, [url.pathname]);

  if (url.pathname === "/login") return <LoginPage />;
  if (!checked || !me) return null;

  const jobMatch = /^\/jobs\/([A-Za-z]+-\d+)$/.exec(url.pathname);
  let page = <JobsPage />;
  if (jobMatch?.[1]) page = <JobDetailPage key={jobMatch[1]} shortId={jobMatch[1].toUpperCase()} />;
  else if (url.pathname === "/new") page = <NewJobPage />;
  else if (url.pathname === "/costs") page = <CostsPage />;

  return (
    <div className="shell">
      <Rail me={me} path={url.pathname} />
      <main className="main" key={url.pathname}>
        {page}
      </main>
    </div>
  );
}
