import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AttachmentInput } from "@dca/core";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Only Discord's CDN: attachment URLs come from callers, so never fetch arbitrary hosts (SSRF).
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

const LOG_EXTENSIONS = new Set([".log", ".txt", ".json", ".md", ".out", ".err", ".trace"]);

export class AttachmentRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttachmentRejectedError";
  }
}

export type AttachmentKind = "image" | "log";

export interface StoredAttachment {
  kind: AttachmentKind;
  filename: string;
  mime: string;
  size: number;
  path: string;
}

export function classifyAttachment(filename: string, contentType?: string): AttachmentKind | null {
  const mime = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return "image";
  if (mime.startsWith("text/") || mime === "application/json") return "log";
  if (LOG_EXTENSIONS.has(path.extname(filename).toLowerCase())) return "log";
  return null;
}

export function safeFilename(filename: string): string {
  const base = path
    .basename(filename)
    .replace(/[^\w.-]+/g, "_")
    .replace(/^\.+/, "");
  return base.slice(0, 120) || "attachment";
}

export type Fetcher = typeof fetch;

/** Downloads attachments into `<dir>/<jobId>/` before the Discord CDN URLs expire. */
export async function downloadAttachments(
  inputs: AttachmentInput[],
  options: { dir: string; jobId: string; fetch?: Fetcher },
): Promise<StoredAttachment[]> {
  const doFetch = options.fetch ?? fetch;
  const checked = inputs.map((input) => {
    const url = new URL(input.url);
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new AttachmentRejectedError(`${input.filename}: only Discord attachments are accepted`);
    }
    if (input.size > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejectedError(`${input.filename}: larger than 10 MB`);
    }
    const kind = classifyAttachment(input.filename, input.contentType);
    if (!kind) {
      throw new AttachmentRejectedError(`${input.filename}: only images and text/log files`);
    }
    return { input, kind };
  });

  const jobDir = path.join(options.dir, options.jobId);
  await mkdir(jobDir, { recursive: true });

  const stored: StoredAttachment[] = [];
  for (const [index, { input, kind }] of checked.entries()) {
    const res = await doFetch(input.url, { redirect: "error" });
    if (!res.ok) throw new AttachmentRejectedError(`${input.filename}: download failed`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new AttachmentRejectedError(`${input.filename}: larger than 10 MB`);
    }
    const filePath = path.join(jobDir, `${index}-${safeFilename(input.filename)}`);
    await writeFile(filePath, data);
    stored.push({
      kind,
      filename: input.filename,
      mime: input.contentType ?? "application/octet-stream",
      size: data.byteLength,
      path: filePath,
    });
  }
  return stored;
}
