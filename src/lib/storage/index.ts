import "server-only";
import { env } from "@/lib/env";
import { createLocalStorage } from "./local";
import { createS3Storage } from "./s3";
import type { StorageProvider } from "./types";

export * from "./types";

declare global {
  var __reelreviewStorage: StorageProvider | undefined;
}

export function getStorage(): StorageProvider {
  if (!globalThis.__reelreviewStorage) {
    globalThis.__reelreviewStorage = env.storageDriver === "s3" ? createS3Storage() : createLocalStorage();
  }
  return globalThis.__reelreviewStorage;
}

export function setStorageForTests(s: StorageProvider | undefined) {
  globalThis.__reelreviewStorage = s;
}

const EXT_BY_TYPE: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-m4v": "m4v",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extensionFor(contentType: string, filename?: string): string {
  const fromName = filename?.split(".").pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  return EXT_BY_TYPE[contentType] ?? "bin";
}
