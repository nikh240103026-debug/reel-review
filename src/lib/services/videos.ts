import "server-only";
import { getDb, type Queryable } from "@/lib/db";
import { env } from "@/lib/env";
import { randomToken } from "@/lib/crypto";
import { formatBytes } from "@/lib/format";
import { badRequest, conflict, notFound } from "@/lib/http";
import { getStorage, choosePartSize, extensionFor, type UploadedPart } from "@/lib/storage";
import { recordActivity } from "./activity";
import { probeMedia } from "./media-probe";
import type { VideoDTO, VideoVersionDTO } from "@/shared/dto";

export const ALLOWED_VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

export function normalizeVideoType(filename: string, contentType: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (Object.values(ALLOWED_VIDEO_TYPES).includes(contentType)) return contentType;
  if (ALLOWED_VIDEO_TYPES[ext]) return ALLOWED_VIDEO_TYPES[ext]!;
  throw badRequest(`Unsupported file type. Allowed: ${Object.keys(ALLOWED_VIDEO_TYPES).join(", ")}`);
}

const VERSION_COLUMNS = `vv.id, vv.video_id, vv.version_number, vv.status, vv.source, vv.original_filename, vv.content_type,
  vv.size_bytes, vv.duration_ms, vv.width, vv.height, vv.frame_rate, vv.video_codec, vv.has_audio, vv.browser_playable,
  vv.processing_error, vv.produced_by_job_id, vv.produced_by_proposal_id, vv.notes, vv.created_at,
  vv.storage_key, vv.thumbnail_key`;

type VersionRow = VideoVersionDTO & { storage_key: string; thumbnail_key: string | null };

async function signVersion(row: VersionRow, withPlayback: boolean): Promise<VideoVersionDTO> {
  const storage = getStorage();
  const { storage_key, thumbnail_key, ...rest } = row;
  return {
    ...rest,
    playback_url: withPlayback && row.status === "ready" ? await storage.presignGet(storage_key) : null,
    thumbnail_url: thumbnail_key ? await storage.presignGet(thumbnail_key) : null,
  };
}

export async function listVersions(videoId: string, opts: { withPlayback?: boolean; readyOnly?: boolean } = {}) {
  const db = await getDb();
  const rows = await db.query<VersionRow>(
    `select ${VERSION_COLUMNS},
       (select count(*) from comments c where c.video_version_id = vv.id and c.parent_id is null)::int as comment_count
       from video_versions vv where vv.video_id = $1 ${opts.readyOnly ? "and vv.status = 'ready'" : ""}
       order by vv.version_number desc`,
    [videoId],
  );
  return Promise.all(rows.map((r) => signVersion(r, opts.withPlayback ?? false)));
}

const VIDEO_SELECT = `
  select v.id, v.project_id, v.title, v.status, v.current_version_id, v.created_at, v.updated_at,
    (select count(*) from video_versions x where x.video_id = v.id)::int as version_count,
    (select count(*) from comments c where c.video_id = v.id and c.parent_id is null and c.status = 'open')::int as open_comment_count
  from videos v`;

type VideoRow = Omit<VideoDTO, "current_version">;

async function attachCurrent(db: Queryable, rows: VideoRow[]): Promise<VideoDTO[]> {
  const out: VideoDTO[] = [];
  for (const v of rows) {
    let current: VideoVersionDTO | null = null;
    // the newest version (any status) is shown so in-progress uploads are visible
    const [row] = await db.query<VersionRow>(
      `select ${VERSION_COLUMNS} from video_versions vv where vv.video_id = $1
       order by (vv.id = $2) desc, vv.version_number desc limit 1`,
      [v.id, v.current_version_id],
    );
    if (row) current = await signVersion(row, false);
    out.push({ ...v, current_version: current });
  }
  return out;
}

export async function listVideos(projectId: string, includeArchived = false): Promise<VideoDTO[]> {
  const db = await getDb();
  const rows = await db.query<VideoRow>(
    `${VIDEO_SELECT} where v.project_id = $1 ${includeArchived ? "" : "and v.status = 'active'"} order by v.created_at desc`,
    [projectId],
  );
  return attachCurrent(db, rows);
}

export async function getVideo(videoId: string): Promise<VideoDTO> {
  const db = await getDb();
  const rows = await db.query<VideoRow>(`${VIDEO_SELECT} where v.id = $1`, [videoId]);
  if (!rows[0]) throw notFound("Video not found");
  return (await attachCurrent(db, rows))[0]!;
}

export async function updateVideo(videoId: string, input: { title?: string; status?: "active" | "archived" }, actor: string) {
  const db = await getDb();
  await db.tx(async (q) => {
    const [v] = await q.query<{ project_id: string; title: string }>("select project_id, title from videos where id = $1", [videoId]);
    if (!v) throw notFound("Video not found");
    await q.query("update videos set title = coalesce($2, title), status = coalesce($3, status) where id = $1", [
      videoId,
      input.title ?? null,
      input.status ?? null,
    ]);
    await recordActivity(q, {
      projectId: v.project_id,
      videoId,
      actorType: "editor",
      actorName: actor,
      eventType: input.status === "archived" ? "video.archived" : input.status === "active" ? "video.restored" : "video.updated",
      data: input.title ? { from: v.title, to: input.title } : {},
    });
  });
}

// ---------------------------------------------------------------------------
// Uploads (direct-to-storage multipart)
// ---------------------------------------------------------------------------

export interface StartUploadInput {
  projectId: string;
  videoId?: string;
  title?: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  source?: "upload" | "manual_revision";
  producedByJobId?: string | null;
  producedByProposalId?: string | null;
  notes?: string | null;
}

export async function startUpload(input: StartUploadInput, actor: string) {
  if (input.sizeBytes <= 0) throw badRequest("File is empty");
  if (input.sizeBytes > env.maxUploadBytes) {
    throw badRequest(`File exceeds the ${formatBytes(env.maxUploadBytes)} upload limit`);
  }
  const contentType = normalizeVideoType(input.filename, input.contentType);
  const db = await getDb();
  const storage = getStorage();
  const partSize = choosePartSize(input.sizeBytes);

  const created = await db.tx(async (q) => {
    const [project] = await q.query<{ status: string }>("select status from projects where id = $1", [input.projectId]);
    if (!project) throw notFound("Project not found");
    if (project.status !== "active") throw conflict("Project is archived");
    let videoId = input.videoId;
    if (videoId) {
      const [v] = await q.query<{ project_id: string }>("select project_id from videos where id = $1 for update", [videoId]);
      if (!v || v.project_id !== input.projectId) throw notFound("Video not found");
    } else {
      const title = (input.title?.trim() || input.filename.replace(/\.[^.]+$/, "")).slice(0, 300);
      const [v] = await q.query<{ id: string }>("insert into videos (project_id, title) values ($1, $2) returning id", [
        input.projectId,
        title,
      ]);
      videoId = v!.id;
    }
    const [{ next }] = (await q.query<{ next: number }>(
      "select coalesce(max(version_number), 0) + 1 as next from video_versions where video_id = $1",
      [videoId],
    )) as [{ next: number }];
    const key = `projects/${input.projectId}/videos/${videoId}/v${next}-${randomToken(6)}/source.${extensionFor(contentType, input.filename)}`;
    const [version] = await q.query<{ id: string }>(
      `insert into video_versions (video_id, version_number, status, source, storage_key, original_filename, content_type,
         size_bytes, part_size_bytes, produced_by_job_id, produced_by_proposal_id, notes)
       values ($1, $2, 'uploading', $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        videoId,
        next,
        input.source ?? "upload",
        key,
        input.filename.slice(0, 500),
        contentType,
        input.sizeBytes,
        partSize,
        input.producedByJobId ?? null,
        input.producedByProposalId ?? null,
        input.notes ?? null,
      ],
    );
    await recordActivity(q, {
      projectId: input.projectId,
      videoId,
      actorType: "editor",
      actorName: actor,
      eventType: "version.upload_started",
      data: { version_number: next, filename: input.filename, size_bytes: input.sizeBytes },
    });
    return { videoId: videoId!, versionId: version!.id, key, versionNumber: next };
  });

  try {
    const { uploadId } = await storage.createMultipart(created.key, contentType);
    await db.query("update video_versions set upload_id = $2 where id = $1", [created.versionId, uploadId]);
    return {
      ...created,
      partSize,
      partCount: Math.ceil(input.sizeBytes / partSize),
      contentType,
    };
  } catch (err) {
    await db.query("update video_versions set status = 'failed', processing_error = $2 where id = $1", [
      created.versionId,
      "Could not start upload with the storage provider",
    ]);
    throw err;
  }
}

async function getUploadingVersion(versionId: string) {
  const db = await getDb();
  const [v] = await db.query<{
    id: string;
    video_id: string;
    status: string;
    storage_key: string;
    upload_id: string | null;
    size_bytes: number;
    part_size_bytes: number;
    project_id: string;
    version_number: number;
    thumbnail_key: string | null;
  }>(
    `select vv.id, vv.video_id, vv.status, vv.storage_key, vv.upload_id, vv.size_bytes, vv.part_size_bytes, vv.version_number,
            vv.thumbnail_key, v.project_id
       from video_versions vv join videos v on v.id = vv.video_id where vv.id = $1`,
    [versionId],
  );
  if (!v) throw notFound("Version not found");
  return v;
}

export async function presignParts(versionId: string, partNumbers: number[]) {
  const v = await getUploadingVersion(versionId);
  if (v.status !== "uploading" || !v.upload_id) throw conflict(`Version is not accepting uploads (status: ${v.status})`);
  const maxPart = Math.ceil(v.size_bytes / v.part_size_bytes);
  const storage = getStorage();
  const urls: Record<number, string> = {};
  for (const n of partNumbers) {
    if (!Number.isInteger(n) || n < 1 || n > maxPart) throw badRequest(`Invalid part number ${n}`);
    urls[n] = await storage.presignPart(v.storage_key, v.upload_id, n, 3600);
  }
  return urls;
}

/** For resuming interrupted uploads: which parts the storage already holds. */
export async function uploadStatus(versionId: string) {
  const v = await getUploadingVersion(versionId);
  const parts = v.status === "uploading" && v.upload_id ? await getStorage().listParts(v.storage_key, v.upload_id) : [];
  return {
    versionId,
    videoId: v.video_id,
    status: v.status,
    sizeBytes: v.size_bytes,
    partSize: v.part_size_bytes,
    partCount: Math.ceil(v.size_bytes / v.part_size_bytes),
    uploadedParts: parts,
  };
}

export function thumbnailKeyFor(storageKey: string) {
  return storageKey.replace(/\/[^/]+$/, "/thumbnail.jpg");
}

export async function presignThumbnail(versionId: string) {
  const v = await getUploadingVersion(versionId);
  const key = thumbnailKeyFor(v.storage_key);
  return { key, url: await getStorage().presignPut(key, { contentType: "image/jpeg", expiresIn: 900 }) };
}

export interface CompleteUploadInput {
  parts: UploadedPart[];
  metadata?: { durationMs?: number | null; width?: number | null; height?: number | null; browserPlayable?: boolean | null };
  thumbnailUploaded?: boolean;
}

export async function completeUpload(versionId: string, input: CompleteUploadInput, actor: string) {
  const v = await getUploadingVersion(versionId);
  const db = await getDb();
  const storage = getStorage();
  if (v.status === "ready") return getVersion(versionId); // idempotent
  if (v.status !== "uploading" || !v.upload_id) throw conflict(`Version cannot be completed (status: ${v.status})`);
  const expectedParts = Math.ceil(v.size_bytes / v.part_size_bytes);
  if (input.parts.length !== expectedParts) {
    throw badRequest(`Expected ${expectedParts} parts, received ${input.parts.length}. Resume the upload to send the missing parts.`);
  }

  try {
    await storage.completeMultipart(v.storage_key, v.upload_id, input.parts);
  } catch (err) {
    throw conflict(`Storage rejected the upload completion: ${(err as Error).message}. Resume the upload and try again.`);
  }
  const head = await storage.head(v.storage_key);
  if (!head || head.size !== v.size_bytes) {
    await db.query("update video_versions set status = 'failed', processing_error = $2, upload_id = null where id = $1", [
      versionId,
      `Stored object size (${head?.size ?? 0} bytes) does not match the expected ${v.size_bytes} bytes`,
    ]);
    throw conflict("Upload verification failed: stored size does not match. The version was marked failed.");
  }

  let thumbnailKey: string | null = null;
  if (input.thumbnailUploaded) {
    const key = thumbnailKeyFor(v.storage_key);
    const th = await storage.head(key);
    if (th && th.size > 0 && th.size < 5 * 1024 * 1024) thumbnailKey = key;
  }

  await db.query(
    `update video_versions set status = 'processing', upload_id = null, thumbnail_key = $2,
       duration_ms = $3, width = $4, height = $5, browser_playable = $6, probe_source = 'browser'
     where id = $1`,
    [
      versionId,
      thumbnailKey,
      input.metadata?.durationMs != null ? Math.round(input.metadata.durationMs) : null,
      input.metadata?.width ?? null,
      input.metadata?.height ?? null,
      input.metadata?.browserPlayable ?? null,
    ],
  );
  await finalizeProcessing(versionId, actor, "editor");
  return getVersion(versionId);
}

/**
 * Probes metadata (if ffprobe is available on the server), marks the version
 * ready or failed, and promotes it to the video's current version.
 */
export async function finalizeProcessing(versionId: string, actorName: string, actorType: "editor" | "agent") {
  const db = await getDb();
  const storage = getStorage();
  const [v] = await db.query<{ storage_key: string; browser_playable: boolean | null; video_id: string; version_number: number; project_id: string }>(
    `select vv.storage_key, vv.browser_playable, vv.video_id, vv.version_number, v.project_id
       from video_versions vv join videos v on v.id = vv.video_id where vv.id = $1`,
    [versionId],
  );
  if (!v) throw notFound("Version not found");
  const probe = await probeMedia(await storage.localPathOrUrl(v.storage_key));
  let status: "ready" | "failed" = "ready";
  let processingError: string | null = null;
  if ("error" in probe) {
    if (probe.error !== "ffprobe not available" && v.browser_playable !== true) {
      // Undecodable and not proven playable by a browser (agent renders have no
      // browser check): never publish it as ready.
      status = "failed";
      processingError = `The file could not be decoded (${probe.error}). Re-export as H.264/AAC MP4 and upload again.`;
    } else if (probe.error !== "ffprobe not available") {
      processingError = `Server could not inspect this file (${probe.error}), but the uploading browser played it.`;
    } else if (v.browser_playable === false) {
      processingError =
        "The uploading browser could not decode this file (likely an unsupported codec). It is stored, but reviewers may not be able to play it. H.264/AAC MP4 is recommended.";
    }
    await db.query("update video_versions set status = $2, processing_error = $3 where id = $1", [versionId, status, processingError]);
  } else {
    if (v.browser_playable === false) {
      processingError = `Stored and probed (${probe.videoCodec ?? "unknown codec"}), but the uploading browser could not play it. Reviewers may need a browser-compatible H.264/AAC MP4.`;
    }
    await db.query(
      `update video_versions set status = 'ready', processing_error = $2, probe_source = 'ffprobe',
         duration_ms = coalesce($3, duration_ms), width = coalesce($4, width), height = coalesce($5, height),
         frame_rate = $6, video_codec = $7, audio_codec = $8, has_audio = $9
       where id = $1`,
      [versionId, processingError, probe.durationMs, probe.width, probe.height, probe.frameRate, probe.videoCodec, probe.audioCodec, probe.hasAudio],
    );
  }
  if (status === "ready") {
    await db.tx(async (q) => {
      // only promote if this is the newest ready version
      await q.query(
        `update videos set current_version_id = $2 where id = $1 and not exists (
           select 1 from video_versions x where x.video_id = $1 and x.status = 'ready' and x.version_number > $3)`,
        [v.video_id, versionId, v.version_number],
      );
      await recordActivity(q, {
        projectId: v.project_id,
        videoId: v.video_id,
        actorType,
        actorName,
        eventType: "version.ready",
        data: { version_number: v.version_number, version_id: versionId },
      });
    });
  }
  return status;
}

export async function abortUpload(versionId: string, reason: string, actor: string) {
  const v = await getUploadingVersion(versionId);
  if (v.status !== "uploading") throw conflict(`Version is not uploading (status: ${v.status})`);
  const db = await getDb();
  if (v.upload_id) {
    await getStorage()
      .abortMultipart(v.storage_key, v.upload_id)
      .catch(() => undefined);
  }
  await db.tx(async (q) => {
    await q.query("update video_versions set status = 'failed', upload_id = null, processing_error = $2 where id = $1", [
      versionId,
      reason.slice(0, 500),
    ]);
    await recordActivity(q, {
      projectId: v.project_id,
      videoId: v.video_id,
      actorType: "editor",
      actorName: actor,
      eventType: "version.upload_failed",
      data: { version_number: v.version_number, reason },
    });
  });
}

export async function getVersion(versionId: string, withPlayback = true): Promise<VideoVersionDTO> {
  const db = await getDb();
  const [row] = await db.query<VersionRow>(`select ${VERSION_COLUMNS} from video_versions vv where vv.id = $1`, [versionId]);
  if (!row) throw notFound("Version not found");
  return signVersion(row, withPlayback);
}

export async function getVersionDownloadUrl(versionId: string) {
  const db = await getDb();
  const [row] = await db.query<{ storage_key: string; original_filename: string; status: string }>(
    "select storage_key, original_filename, status from video_versions where id = $1",
    [versionId],
  );
  if (!row || row.status !== "ready") throw notFound("Version not available");
  return getStorage().presignGet(row.storage_key, { downloadName: row.original_filename, expiresIn: 900 });
}
