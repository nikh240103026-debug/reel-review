import "server-only";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env, ConfigError } from "@/lib/env";
import type { StorageProvider, UploadedPart } from "./types";

/** Any S3-compatible object store. The bucket must be private. */
export function createS3Storage(): StorageProvider {
  const cfg = env.s3;
  if (!cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKey) {
    throw new ConfigError("S3-compatible storage selected but S3_BUCKET, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY is missing.");
  }
  const bucket = cfg.bucket;
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: cfg.forcePathStyle,
    requestChecksumCalculation: "WHEN_REQUIRED",
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const ttl = (s?: number) => s ?? env.signedUrlTtlSeconds;

  return {
    kind: "s3",
    describe: () => `S3-compatible bucket "${bucket}"${cfg.endpoint ? ` at ${new URL(cfg.endpoint).host}` : ""}`,
    presignGet(key, opts) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: opts?.downloadName
            ? `attachment; filename="${opts.downloadName.replace(/[^\w.\- ]/g, "_")}"`
            : undefined,
        }),
        { expiresIn: ttl(opts?.expiresIn) },
      );
    },
    presignPut(key, opts) {
      return getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: opts.contentType }), {
        expiresIn: ttl(opts.expiresIn),
      });
    },
    async createMultipart(key, contentType) {
      const res = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }));
      if (!res.UploadId) throw new Error("Storage did not return an upload id");
      return { uploadId: res.UploadId };
    },
    presignPart(key, uploadId, partNumber, expiresIn) {
      return getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn: ttl(expiresIn) },
      );
    },
    async listParts(key, uploadId) {
      const parts: UploadedPart[] = [];
      let marker: string | undefined;
      for (;;) {
        const res = await client.send(
          new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker }),
        );
        for (const p of res.Parts ?? []) {
          if (p.PartNumber && p.ETag) parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
        }
        if (!res.IsTruncated || !res.NextPartNumberMarker) break;
        marker = res.NextPartNumberMarker;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },
    async completeMultipart(key, uploadId, parts) {
      const sorted: Part[] = [...parts]
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: sorted },
        }),
      );
    },
    async abortMultipart(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    },
    async head(key) {
      try {
        const res = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return { size: Number(res.ContentLength ?? 0), contentType: res.ContentType };
      } catch (err) {
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404 || (err as Error).name === "NotFound") return null;
        throw err;
      }
    },
    localPathOrUrl(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 });
    },
  };
}
