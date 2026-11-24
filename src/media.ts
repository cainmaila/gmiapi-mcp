import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { GmiClient, GmiRequest } from "./gmi.js";

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

export interface SavedMedia {
  url: string;
  file: string;
  mimeType: string;
  bytes: number;
  /** base64 data, only kept for images small enough to inline */
  data?: string;
}

function guessMime(url: string, header: string | null): string {
  const h = header?.split(";")[0].trim().toLowerCase();
  if (h && h !== "application/octet-stream" && h !== "binary/octet-stream") return h;
  const ext = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  const found = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext || (ext === "jpeg" && e === "jpg"));
  return found?.[0] ?? "application/octet-stream";
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60);
}

/** Download every media URL in a finished request into outputDir. */
export async function downloadOutcome(
  req: GmiRequest,
  outputDir: string,
  maxInlineBytes: number,
): Promise<SavedMedia[]> {
  const urls = req.outcome?.media_urls ?? [];
  if (!urls.length) return [];
  const dir = expandHome(outputDir);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const base = `${stamp}_${safe(req.model ?? "gmi")}_${req.request_id.slice(0, 8)}`;

  return Promise.all(
    urls.map(async (m, i): Promise<SavedMedia> => {
      const res = await fetch(m.url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${m.url}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const mimeType = guessMime(m.url, res.headers.get("content-type"));
      const ext = EXT_BY_MIME[mimeType] ?? (path.extname(new URL(m.url).pathname).slice(1) || "bin");
      const file = path.join(dir, `${base}_${m.id ?? i}.${ext}`);
      await writeFile(file, buf);
      const inline = mimeType.startsWith("image/") && buf.byteLength <= maxInlineBytes;
      return { url: m.url, file, mimeType, bytes: buf.byteLength, data: inline ? buf.toString("base64") : undefined };
    }),
  );
}

/**
 * Turn a list of image references into URLs GMI can fetch.
 * http(s)/data URLs pass through; local paths are uploaded via the Upload API.
 */
export async function resolveReferences(client: GmiClient, refs: string[]): Promise<string[]> {
  return Promise.all(
    refs.map(async (ref) => {
      if (/^(https?:|data:)/i.test(ref)) return ref;
      const p = path.resolve(expandHome(ref.replace(/^file:\/\//, "")));
      const st = await stat(p).catch(() => null);
      if (!st?.isFile()) throw new Error(`Reference "${ref}" is neither a URL nor an existing local file`);
      const ext = path.extname(p).slice(1).toLowerCase();
      if (["png", "jpg", "jpeg"].includes(ext)) return client.uploadFile(p);
      // Upload API only takes jpg/png; send other image types inline as a data URI.
      const mime = Object.entries(EXT_BY_MIME).find(([m, e]) => e === ext && m.startsWith("image/"))?.[0];
      if (!mime) throw new Error(`Unsupported reference file type ".${ext}" (${ref})`);
      return `data:${mime};base64,${(await readFile(p)).toString("base64")}`;
    }),
  );
}
