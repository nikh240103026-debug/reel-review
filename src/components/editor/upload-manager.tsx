"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, Upload, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { errorText } from "@/lib/client/api";
import { uploadVideo, type UploadProgress } from "@/lib/client/uploader";
import { formatBytes } from "@/lib/format";

const ACCEPT = "video/mp4,video/quicktime,video/webm,video/x-matroska,video/x-m4v,.mp4,.mov,.webm,.mkv,.m4v";

interface Item {
  key: string;
  file: File;
  progress: UploadProgress;
  state: "active" | "done" | "error" | "cancelled";
  error?: string;
  warning?: string | null;
  controller: AbortController;
  options: UploadTarget;
}

export interface UploadTarget {
  projectId: string;
  videoId?: string;
  source?: "upload" | "manual_revision";
  jobId?: string;
  proposalId?: string;
  notes?: string;
  resumeVersionId?: string;
}

export function useUploads(onDone?: (r: { versionId: string; videoId: string }) => void) {
  const router = useRouter();
  const [items, setItems] = useState<Item[]>([]);

  const update = useCallback(
    (key: string, patch: Partial<Item>) => setItems((prev) => prev.map((i) => (i.key === key ? { ...i, ...patch } : i))),
    [],
  );

  const start = useCallback(
    (file: File, target: UploadTarget) => {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      const controller = new AbortController();
      const item: Item = { key, file, progress: { phase: "probing", loaded: 0, total: file.size }, state: "active", controller, options: target };
      setItems((prev) => [...prev, item]);
      uploadVideo({
        file,
        ...target,
        signal: controller.signal,
        onProgress: (p) => update(key, { progress: p }),
      })
        .then((res) => {
          update(key, { state: "done", warning: res.warning });
          if (res.warning) toast.warning(res.warning);
          else toast.success(`${file.name} is ready for review`);
          onDone?.({ versionId: res.versionId, videoId: res.videoId });
          router.refresh();
        })
        .catch((err) => {
          if ((err as Error).name === "AbortError") {
            update(key, { state: "cancelled" });
            router.refresh();
            return;
          }
          update(key, { state: "error", error: errorText(err) });
          toast.error(`${file.name}: ${errorText(err)}`);
          router.refresh();
        });
    },
    [router, onDone, update],
  );

  const cancel = useCallback((key: string) => {
    items.find((i) => i.key === key)?.controller.abort();
  }, [items]);

  const dismiss = (key: string) => setItems((prev) => prev.filter((i) => i.key !== key));

  return { items, start, cancel, dismiss };
}

export function UploadList({ uploads }: { uploads: ReturnType<typeof useUploads> }) {
  if (!uploads.items.length) return null;
  return (
    <div className="space-y-2">
      {uploads.items.map((i) => {
        const pct = i.progress.total ? Math.round((i.progress.loaded / i.progress.total) * 100) : 0;
        return (
          <div key={i.key} className="rounded-lg border bg-card px-3 py-2.5">
            <div className="flex items-center gap-3">
              {i.state === "active" && <Loader2 className="size-4 shrink-0 animate-spin text-info" />}
              {i.state === "done" && (i.warning ? <AlertTriangle className="size-4 shrink-0 text-warning" /> : <CheckCircle2 className="size-4 shrink-0 text-success" />)}
              {(i.state === "error" || i.state === "cancelled") && <AlertTriangle className="size-4 shrink-0 text-destructive" />}
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{i.file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {i.state === "active" &&
                    (i.progress.phase === "probing"
                      ? "Checking file…"
                      : i.progress.phase === "starting"
                        ? "Preparing upload…"
                        : i.progress.phase === "finalizing"
                          ? "Verifying upload…"
                          : `${formatBytes(i.progress.loaded)} of ${formatBytes(i.progress.total)} · ${pct}%`)}
                  {i.state === "done" && (i.warning ?? "Uploaded and verified")}
                  {i.state === "error" && <span className="text-destructive">{i.error}</span>}
                  {i.state === "cancelled" && "Cancelled"}
                </div>
              </div>
              {i.state === "active" ? (
                <Button size="icon-sm" variant="ghost" aria-label="Cancel upload" onClick={() => uploads.cancel(i.key)}>
                  <X />
                </Button>
              ) : (
                <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => uploads.dismiss(i.key)}>
                  <X />
                </Button>
              )}
            </div>
            {i.state === "active" && <Progress value={i.progress.phase === "uploading" ? pct : i.progress.phase === "finalizing" ? 100 : 2} className="mt-2 h-1" />}
          </div>
        );
      })}
    </div>
  );
}

export function FilePickButton({
  onFiles,
  multiple = true,
  children,
  variant = "default",
  size = "default",
}: {
  onFiles: (files: File[]) => void;
  multiple?: boolean;
  children?: React.ReactNode;
  variant?: "default" | "outline" | "secondary" | "ghost";
  size?: "default" | "sm" | "xs";
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={ACCEPT}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) onFiles(files);
        }}
      />
      <Button variant={variant} size={size} onClick={() => ref.current?.click()}>
        {children ?? (
          <>
            <Upload /> Upload video
          </>
        )}
      </Button>
    </>
  );
}

export function ResumeButton({ uploads, projectId, videoId, versionId }: { uploads: ReturnType<typeof useUploads>; projectId: string; videoId: string; versionId: string }) {
  return (
    <FilePickButton
      multiple={false}
      variant="outline"
      size="xs"
      onFiles={([f]) => f && uploads.start(f, { projectId, videoId, resumeVersionId: versionId })}
    >
      <RotateCcw /> Resume
    </FilePickButton>
  );
}
