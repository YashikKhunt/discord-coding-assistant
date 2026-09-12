import { describe, expect, it } from "vitest";
import { classifyAttachment, safeFilename } from "./attachments.ts";

describe("classifyAttachment", () => {
  it("accepts images and text logs only", () => {
    expect(classifyAttachment("shot.png", "image/png")).toBe("image");
    expect(classifyAttachment("out.log", "text/plain; charset=utf-8")).toBe("log");
    expect(classifyAttachment("trace.log", "application/octet-stream")).toBe("log");
    expect(classifyAttachment("image.svg", "image/svg+xml")).toBeNull();
    expect(classifyAttachment("app.zip", "application/zip")).toBeNull();
  });
});

describe("safeFilename", () => {
  it("strips paths and unsafe characters", () => {
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("my file (1).log")).toBe("my_file_1_.log");
    expect(safeFilename("...")).toBe("attachment");
  });
});
