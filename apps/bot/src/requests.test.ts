import { describe, expect, it } from "vitest";
import { isAllowed } from "./access.ts";
import { buildCreateJobRequest, type CommandOptions } from "./requests.ts";

function options(
  strings: Record<string, string>,
  attachments: Record<
    string,
    { url: string; name: string; contentType: string | null; size: number }
  > = {},
): CommandOptions {
  return {
    getString: (name) => strings[name] ?? null,
    getAttachment: (name) => attachments[name] ?? null,
  };
}

describe("buildCreateJobRequest", () => {
  it("maps /task options and attachments", () => {
    const request = buildCreateJobRequest(
      "task",
      options(
        { repo: " octo/app ", description: " add rate limiting ", base: "" },
        {
          attachment2: {
            url: "https://cdn.discordapp.com/a.png",
            name: "a.png",
            contentType: "image/png",
            size: 10,
          },
        },
      ),
      "111111111111111111",
    );
    expect(request).toEqual({
      type: "task",
      repo: "octo/app",
      requestedByDiscordId: "111111111111111111",
      input: { description: "add rate limiting", base: undefined },
      attachments: [
        {
          url: "https://cdn.discordapp.com/a.png",
          filename: "a.png",
          contentType: "image/png",
          size: 10,
        },
      ],
    });
  });

  it("maps /bugreport and /runtest options", () => {
    expect(
      buildCreateJobRequest(
        "bugreport",
        options({ repo: "o/r", description: "crash", steps: "1. open", issue: "#4" }),
        "1",
      ).input,
    ).toEqual({ description: "crash", steps: "1. open", expected: undefined, issue: "#4" });

    expect(buildCreateJobRequest("runtest", options({ repo: "o/r", ref: "#12" }), "1")).toEqual({
      type: "runtest",
      repo: "o/r",
      ref: "#12",
      requestedByDiscordId: "1",
      input: {},
    });
  });
});

describe("isAllowed", () => {
  const allowlist = { userIds: ["u1"], roleIds: ["r1"] };

  it("allows listed users or roles only", () => {
    expect(isAllowed(allowlist, "u1", [])).toBe(true);
    expect(isAllowed(allowlist, "u2", ["r0", "r1"])).toBe(true);
    expect(isAllowed(allowlist, "u2", ["r0"])).toBe(false);
    expect(isAllowed({ userIds: [], roleIds: [] }, "u1", ["r1"])).toBe(false);
  });
});
