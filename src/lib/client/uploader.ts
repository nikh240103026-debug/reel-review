"use client";

import { api } from "./api";

/**
 * Resumable direct-to-storage multipart uploader.
 * Video bytes go straight to object storage via presigned part URLs; the app
 * server only signs URLs and verifies completion. Progress is kept in
 * localStorage so an interrupted upload can resume with the same file.
 */

export interface BrowserProbe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
  playable: boolean;
  thumbnail: Blob | null;
}

export interface UploadProgress {
  phase: "probing" | "starting" | "uploading" | "finalizing" | "done";
  loaded: number;
  total: number;
}

const RESUME_KEY = "rr.uploads";

interface ResumeRecord {
  versionId: string;
  videoId: string;
  projectId: string;
  fingerprint: string;
  filename: string;
  sizeBytes: number;
  startedAt: string;
}

function fingerprint(f: File) {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

export function listResumable(projectId?: string): ResumeRecord[] {
  try {
    const all = JSON.parse(localStorage.getItem(RESUME_KEY) ?? "[]") as ResumeRecord[];
    return projectId ? all.filter((r) => r.projectId === projectId) : all;
  } catch {
    return [];
  }
}

function saveResume(rec: ResumeRecord) {
  try {
    const all = listResumable().filter((r) => r.versionId !== rec.versionId);
    localStorage.setItem(RESUME_KEY, JSON.stringify([...all, rec].slice(-20)));
  } catch {
    /* storage unavailable: resume will need the server's part list only */
  }
}

export function forgetResume(versionId: string) {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(listResumable().filter((r) => r.versionId !== versionId)));
  } catch {
    /* ignore */
  }
}

/** Reads duration/resolution, checks the browser can decode it, and grabs a thumbnail. */
export function probeInBrowser(file: File, timeoutMs = 15000): Promise<BrowserProbe> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    let settled = false;
    const finish = (p: BrowserProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
      resolve(p);
    };
    const timer = setTimeout(() => finish({ durationMs: null, width: null, height: null, playable: false, thumbnail: null }), timeoutMs);
    video.onerror = () => finish({ durationMs: null, width: null, height: null, playable: false, thumbnail: null });
    video.onloadedmetadata = () => {
      const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null;
      const width = video.videoWidth || null;
      const height = video.videoHeight || null;
      if (!width || !height) {
        // audio-only or undecodable video track
        finish({ durationMs, width, height, playable: false, thumbnail: null });
        return;
      }
      video.currentTime = Math.min(1, (video.duration || 2) / 3);
      video.onseeked = () => {
        try {
          const scale = Math.min(1, 640 / width);
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(width * scale);
          canvas.height = Math.round(height * scale);
          canvas.getContext("2d")!.drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob((blob) => finish({ durationMs, width, height, playable: true, thumbnail: blob }), "image/jpeg", 0.82);
        } catch {
          finish({ durationMs, width, height, playable: true, thumbnail: null });
        }
      };
    };
    video.src = url;
  });
}

async function putWithRetry(url: string, body: Blob, signal?: AbortSignal, contentType?: string): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
    try {
      const res = await fetch(url, { method: "PUT", body, signal, headers: contentType ? { "Content-Type": contentType } : undefined });
      if (!res.ok) throw new Error(`Storage responded ${res.status}`);
      const etag = res.headers.get("ETag") ?? res.headers.get("etag");
      if (!etag && !contentType) {
        throw new Error("Storage did not expose the ETag header. Configure the provider's CORS policy to expose ETag.");
      }
      return etag ?? "";
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      lastErr = err;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Upload failed");
}

export interface UploadOptions {
  file: File;
  projectId: string;
  videoId?: string;
  title?: string;
  source?: "upload" | "manual_revision";
  jobId?: string;
  proposalId?: string;
  notes?: string;
  /** resume an existing version instead of starting a new one */
  resumeVersionId?: string;
  onProgress?: (p: UploadProgress) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  versionId: string;
  videoId: string;
  status: string;
  warning: string | null;
}

export async function uploadVideo(opts: UploadOptions): Promise<UploadResult> {
  const { file, onProgress, signal } = opts;
  if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");
  onProgress?.({ phase: "probing", loaded: 0, total: file.size });
  const probe = await probeInBrowser(file);
  if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");

  onProgress?.({ phase: "starting", loaded: 0, total: file.size });
  let versionId: string;
  let videoId: string;
  let partSize: number;
  let partCount: number;
  const done = new Map<number, string>();

  if (opts.resumeVersionId) {
    const status = await api<{
      versionId: string;
      videoId: string;
      status: string;
      sizeBytes: number;
      partSize: number;
      partCount: number;
      uploadedParts: { partNumber: number; etag: string; size?: number }[];
    }>(`/api/editor/uploads/${opts.resumeVersionId}`, { signal });
    if (status.status !== "uploading") throw new Error(`This upload can no longer be resumed (status: ${status.status}).`);
    if (status.sizeBytes !== file.size) throw new Error("This file does not match the interrupted upload (different size). Choose the same file.");
    const savedResume = listResumable().find((record) => record.versionId === status.versionId);
    if (savedResume && savedResume.fingerprint !== fingerprint(file)) {
      throw new Error("This is a different file from the interrupted upload. Choose the original file.");
    }
    if (!savedResume && status.uploadedParts.length > 0) {
      throw new Error("This upload cannot be resumed safely because its original file could not be verified. Discard it and start again.");
    }
    versionId = status.versionId;
    videoId = status.videoId;
    partSize = status.partSize;
    partCount = status.partCount;
    for (const p of status.uploadedParts) {
      const expected = p.partNumber === partCount ? file.size - (partCount - 1) * partSize : partSize;
      if (p.size === undefined || p.size === expected) done.set(p.partNumber, p.etag);
    }
  } else {
    const started = await api<{ versionId: string; videoId: string; partSize: number; partCount: number; contentType: string }>(
      "/api/editor/uploads",
      {
        body: {
          projectId: opts.projectId,
          videoId: opts.videoId,
          title: opts.title,
          filename: file.name,
          contentType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          source: opts.source,
          jobId: opts.jobId,
          proposalId: opts.proposalId,
          notes: opts.notes,
        },
      },
    );
    versionId = started.versionId;
    videoId = started.videoId;
    partSize = started.partSize;
    partCount = started.partCount;
  }

  saveResume({
    versionId,
    videoId,
    projectId: opts.projectId,
    fingerprint: fingerprint(file),
    filename: file.name,
    sizeBytes: file.size,
    startedAt: new Date().toISOString(),
  });

  try {
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");

    const sizeOf = (n: number) => (n === partCount ? file.size - (partCount - 1) * partSize : partSize);
    let loaded = [...done.keys()].reduce((sum, n) => sum + sizeOf(n), 0);
    onProgress?.({ phase: "uploading", loaded, total: file.size });

    const pending = Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
    const urlCache = new Map<number, string>();
    async function urlFor(n: number) {
      if (!urlCache.has(n)) {
        const batch = pending.filter((p) => p >= n && !done.has(p)).slice(0, 20);
        const { urls } = await api<{ urls: Record<string, string> }>(`/api/editor/uploads/${versionId}/parts`, {
          body: { partNumbers: batch },
          signal,
        });
        for (const [k, v] of Object.entries(urls)) urlCache.set(Number(k), v);
      }
      return urlCache.get(n)!;
    }

    const queue = [...pending];
    const worker = async () => {
      while (queue.length) {
        const n = queue.shift()!;
        const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
        const url = await urlFor(n);
        const etag = await putWithRetry(url, blob, signal);
        done.set(n, etag);
        loaded += blob.size;
        onProgress?.({ phase: "uploading", loaded, total: file.size });
      }
    }
    // Prefetch URLs sequentially for the first batch, then upload with 3 workers.
    if (pending.length) await urlFor(pending[0]!);
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));

    onProgress?.({ phase: "finalizing", loaded: file.size, total: file.size });
    let thumbnailUploaded = false;
    if (probe.thumbnail) {
      try {
        const { url, contentType } = await api<{ url: string; contentType: string }>(`/api/editor/uploads/${versionId}/thumbnail`, {
          body: {},
          signal,
        });
        await putWithRetry(url, probe.thumbnail, signal, contentType);
        thumbnailUploaded = true;
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        thumbnailUploaded = false; // thumbnail is optional
      }
    }
    if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError");

    const { version } = await api<{ version: { id: string; status: string; processing_error: string | null } }>(
      `/api/editor/uploads/${versionId}/complete`,
      {
        body: {
          parts: [...done.entries()].sort((a, b) => a[0] - b[0]).map(([partNumber, etag]) => ({ partNumber, etag })),
          metadata: { durationMs: probe.durationMs, width: probe.width, height: probe.height, browserPlayable: probe.playable },
          thumbnailUploaded,
        },
      },
    );
    forgetResume(versionId);
    onProgress?.({ phase: "done", loaded: file.size, total: file.size });
    return { versionId, videoId, status: version.status, warning: version.processing_error };
  } catch (err) {
    if ((err as Error).name === "AbortError") await abortUpload(versionId);
    throw err;
  }
}

export async function abortUpload(versionId: string, reason = "Cancelled by editor") {
  forgetResume(versionId);
  await api(`/api/editor/uploads/${versionId}/abort`, { body: { reason } });
}
