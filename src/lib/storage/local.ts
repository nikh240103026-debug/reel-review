import "server-only";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { env } from "@/lib/env";
import { hmac, safeEqual } from "@/lib/crypto";
import type { StorageProvider, UploadedPart } from "./types";

/**
 * LOCAL DEVELOPMENT MODE object storage.
 * Emulates a private bucket on the local filesystem. Every URL is HMAC-signed
 * with an expiry, exactly like S3 presigned URLs, and is served by
 * /api/storage/local (excluded from the proxy so large bodies stream to disk).
 */

export type LocalOp = "get" | "put" | "part";

export interface LocalSignedParams {
  op: LocalOp;
  key: string;
  exp: number;
  uploadId?: string;
  partNumber?: number;
  contentType?: string;
  download?: string;
}

function root() {
  return path.resolve(env.localStorageDir);
}

export function objectPath(key: string): string {
  if (!/^[A-Za-z0-9._\-/]+$/.test(key) || key.includes("..") || key.startsWith("/")) {
    throw new Error("Invalid storage key");
  }
  const p = path.resolve(root(), "objects", key);
  if (!p.startsWith(path.resolve(root(), "objects") + path.sep)) throw new Error("Invalid storage key");
  return p;
}

function multipartDir(uploadId: string): string {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(uploadId)) throw new Error("Invalid upload id");
  return path.resolve(root(), "multipart", uploadId);
}

function signatureBase(p: LocalSignedParams): string {
  return [p.op, p.key, p.exp, p.uploadId ?? "", p.partNumber ?? "", p.contentType ?? "", p.download ?? ""].join("\n");
}

export function signLocal(p: LocalSignedParams): string {
  const url = new URL("/api/storage/local", env.appUrl);
  url.searchParams.set("op", p.op);
  url.searchParams.set("key", p.key);
  url.searchParams.set("exp", String(p.exp));
  if (p.uploadId) url.searchParams.set("uploadId", p.uploadId);
  if (p.partNumber) url.searchParams.set("partNumber", String(p.partNumber));
  if (p.contentType) url.searchParams.set("contentType", p.contentType);
  if (p.download) url.searchParams.set("download", p.download);
  url.searchParams.set("sig", hmac(signatureBase(p), "local-storage"));
  return url.toString();
}

export function verifyLocal(search: URLSearchParams): LocalSignedParams | null {
  const op = search.get("op") as LocalOp | null;
  const key = search.get("key");
  const exp = Number(search.get("exp"));
  const sig = search.get("sig");
  if (!op || !["get", "put", "part"].includes(op) || !key || !sig || !Number.isFinite(exp)) return null;
  const p: LocalSignedParams = {
    op,
    key,
    exp,
    uploadId: search.get("uploadId") ?? undefined,
    partNumber: search.get("partNumber") ? Number(search.get("partNumber")) : undefined,
    contentType: search.get("contentType") ?? undefined,
    download: search.get("download") ?? undefined,
  };
  if (!safeEqual(sig, hmac(signatureBase(p), "local-storage"))) return null;
  if (exp * 1000 < Date.now()) return null;
  return p;
}

const expAt = (seconds?: number) => Math.floor(Date.now() / 1000) + (seconds ?? env.signedUrlTtlSeconds);

export async function readMeta(key: string): Promise<{ contentType?: string }> {
  try {
    return JSON.parse(await fsp.readFile(objectPath(key) + ".meta.json", "utf8"));
  } catch {
    return {};
  }
}

export async function writeObjectMeta(key: string, contentType?: string) {
  await fsp.writeFile(objectPath(key) + ".meta.json", JSON.stringify({ contentType }));
}

export async function writePartFile(uploadId: string, partNumber: number, body: ReadableStream<Uint8Array>) {
  const dir = multipartDir(uploadId);
  await fsp.access(path.join(dir, "upload.json")); // upload must exist
  const tmp = path.join(dir, `${partNumber}.part.tmp-${crypto.randomBytes(4).toString("hex")}`);
  const hash = crypto.createHash("md5");
  let size = 0;
  const out = fs.createWriteStream(tmp);
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      size += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  const etag = `"${hash.digest("hex")}"`;
  await fsp.rename(tmp, path.join(dir, `${partNumber}.part`));
  await fsp.writeFile(path.join(dir, `${partNumber}.etag`), JSON.stringify({ etag, size }));
  return { etag, size };
}

export async function writeWholeObject(key: string, contentType: string | undefined, body: ReadableStream<Uint8Array>) {
  const target = objectPath(key);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${crypto.randomBytes(4).toString("hex")}`;
  const out = fs.createWriteStream(tmp);
  const reader = body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  await fsp.rename(tmp, target);
  await writeObjectMeta(key, contentType);
  return { size };
}

export function createLocalStorage(): StorageProvider {
  return {
    kind: "local",
    describe: () => `Local filesystem (development mode) at ${root()}`,
    async presignGet(key, opts) {
      return signLocal({ op: "get", key, exp: expAt(opts?.expiresIn), download: opts?.downloadName });
    },
    async presignPut(key, opts) {
      return signLocal({ op: "put", key, exp: expAt(opts.expiresIn), contentType: opts.contentType });
    },
    async createMultipart(key, contentType) {
      objectPath(key); // validate
      const uploadId = crypto.randomBytes(18).toString("base64url");
      const dir = multipartDir(uploadId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "upload.json"), JSON.stringify({ key, contentType }));
      return { uploadId };
    },
    async presignPart(key, uploadId, partNumber, expiresIn) {
      return signLocal({ op: "part", key, uploadId, partNumber, exp: expAt(expiresIn) });
    },
    async listParts(_key, uploadId) {
      const dir = multipartDir(uploadId);
      let files: string[] = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        return [];
      }
      const parts: UploadedPart[] = [];
      for (const f of files) {
        const m = /^(\d+)\.etag$/.exec(f);
        if (!m) continue;
        const info = JSON.parse(await fsp.readFile(path.join(dir, f), "utf8"));
        parts.push({ partNumber: Number(m[1]), etag: info.etag, size: info.size });
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },
    async completeMultipart(key, uploadId, parts) {
      const dir = multipartDir(uploadId);
      const meta = JSON.parse(await fsp.readFile(path.join(dir, "upload.json"), "utf8")) as {
        key: string;
        contentType?: string;
      };
      if (meta.key !== key) throw new Error("Upload id does not belong to this key");
      const stored = new Map((await this.listParts(key, uploadId)).map((p) => [p.partNumber, p]));
      const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      if (sorted.length === 0) throw new Error("No parts to complete");
      for (const p of sorted) {
        const s = stored.get(p.partNumber);
        if (!s || s.etag !== p.etag) throw new Error(`Part ${p.partNumber} is missing or its ETag does not match`);
      }
      const target = objectPath(key);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const tmp = `${target}.tmp-${crypto.randomBytes(4).toString("hex")}`;
      const out = fs.createWriteStream(tmp);
      for (const p of sorted) {
        await new Promise<void>((resolve, reject) => {
          const input = fs.createReadStream(path.join(dir, `${p.partNumber}.part`));
          input.on("error", reject);
          input.on("end", () => resolve());
          input.pipe(out, { end: false });
        });
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
      await fsp.rename(tmp, target);
      await writeObjectMeta(key, meta.contentType);
      await fsp.rm(dir, { recursive: true, force: true });
    },
    async abortMultipart(_key, uploadId) {
      await fsp.rm(multipartDir(uploadId), { recursive: true, force: true });
    },
    async head(key) {
      try {
        const st = await fsp.stat(objectPath(key));
        const meta = await readMeta(key);
        return { size: st.size, contentType: meta.contentType };
      } catch {
        return null;
      }
    },
    async localPathOrUrl(key) {
      return objectPath(key);
    },
  };
}
