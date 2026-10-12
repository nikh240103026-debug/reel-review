import fs from "node:fs";
import { Readable } from "node:stream";
import { env } from "@/lib/env";
import { json } from "@/lib/http";
import { log } from "@/lib/log";
import { objectPath, readMeta, verifyLocal, writePartFile, writeWholeObject } from "@/lib/storage/local";

/**
 * LOCAL DEVELOPMENT MODE storage endpoint (emulates presigned S3 URLs).
 * Every request must carry a valid, unexpired HMAC signature. Disabled when
 * the S3/R2 driver is active.
 */

function deny(status: number, error: string) {
  return json({ error }, status);
}

export async function GET(req: Request) {
  if (env.storageDriver !== "local") return deny(404, "Not found");
  const p = verifyLocal(new URL(req.url).searchParams);
  if (!p || p.op !== "get") return deny(403, "Invalid or expired signature");
  let file: string;
  try {
    file = objectPath(p.key);
  } catch {
    return deny(400, "Invalid key");
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return deny(404, "Not found");
  }
  const meta = await readMeta(p.key);
  const headers: Record<string, string> = {
    "Content-Type": meta.contentType ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=300",
  };
  if (p.download) headers["Content-Disposition"] = `attachment; filename="${p.download.replace(/[^\w.\- ]/g, "_")}"`;

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    let start = m[1] ? Number(m[1]) : NaN;
    let end = m[2] ? Number(m[2]) : stat.size - 1;
    if (Number.isNaN(start)) {
      // suffix range: last N bytes
      start = Math.max(0, stat.size - end);
      end = stat.size - 1;
    }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${stat.size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headers, "Content-Length": String(end - start + 1), "Content-Range": `bytes ${start}-${end}/${stat.size}` },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(stat.size) } });
}

export async function PUT(req: Request) {
  if (env.storageDriver !== "local") return deny(404, "Not found");
  const p = verifyLocal(new URL(req.url).searchParams);
  if (!p || (p.op !== "put" && p.op !== "part")) return deny(403, "Invalid or expired signature");
  if (!req.body) return deny(400, "Empty body");
  try {
    if (p.op === "part") {
      if (!p.uploadId || !p.partNumber) return deny(400, "Missing part info");
      const { etag } = await writePartFile(p.uploadId, p.partNumber, req.body);
      return new Response(null, { status: 200, headers: { ETag: etag, "Access-Control-Expose-Headers": "ETag" } });
    }
    const ct = req.headers.get("content-type") ?? undefined;
    if (p.contentType && ct !== p.contentType) return deny(400, "Content-Type does not match the signed URL");
    await writeWholeObject(p.key, ct, req.body);
    return new Response(null, { status: 200 });
  } catch (err) {
    log.warn("storage.local_put_failed", { op: p.op, error: (err as Error).message });
    return deny(400, "Upload failed");
  }
}
