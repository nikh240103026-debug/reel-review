export interface UploadedPart {
  partNumber: number;
  etag: string;
  size?: number;
}

export interface ObjectInfo {
  size: number;
  contentType?: string;
}

/**
 * Object storage provider. Video binaries never pass through the app's API
 * routes: clients upload/download directly with short-lived signed URLs.
 */
export interface StorageProvider {
  kind: "s3" | "local";
  /** Human-readable description for the settings page (no secrets). */
  describe(): string;
  presignGet(key: string, opts?: { expiresIn?: number; downloadName?: string }): Promise<string>;
  presignPut(key: string, opts: { contentType: string; expiresIn?: number }): Promise<string>;
  createMultipart(key: string, contentType: string): Promise<{ uploadId: string }>;
  presignPart(key: string, uploadId: string, partNumber: number, expiresIn?: number): Promise<string>;
  listParts(key: string, uploadId: string): Promise<UploadedPart[]>;
  completeMultipart(key: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Server-side read access, used for optional ffprobe metadata extraction. */
  localPathOrUrl(key: string): Promise<string>;
}

export const MIN_PART_SIZE = 8 * 1024 * 1024;
export const MAX_PARTS = 9_000; // S3/R2 hard limit is 10,000

export function choosePartSize(totalBytes: number): number {
  const needed = Math.ceil(totalBytes / MAX_PARTS);
  return Math.max(MIN_PART_SIZE, Math.ceil(needed / (1024 * 1024)) * 1024 * 1024);
}
