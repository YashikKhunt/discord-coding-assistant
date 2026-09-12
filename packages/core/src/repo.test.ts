import { describe, expect, it } from "vitest";
import { parseRepo } from "./repo.ts";

describe("parseRepo", () => {
  it("accepts exact owner/repo", () => {
    expect(parseRepo("YashikKhunt/my-api")).toEqual({
      owner: "YashikKhunt",
      name: "my-api",
      fullName: "YashikKhunt/my-api",
    });
    expect(parseRepo(" octo-org/some.repo_v2 ")?.fullName).toBe("octo-org/some.repo_v2");
  });

  it("rejects everything else", () => {
    for (const input of [
      "my-api",
      "https://github.com/a/b",
      "a/b/c",
      "-bad/repo",
      "owner/..",
      "owner/",
      "",
    ]) {
      expect(parseRepo(input), input).toBeNull();
    }
  });
});
