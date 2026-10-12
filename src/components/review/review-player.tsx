"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize,
  Minimize,
  Pause,
  Play,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatTimecode } from "@/lib/format";
import { AnnotationLayer } from "./annotation-layer";
import type { AnnotationStroke } from "@/shared/dto";

export interface PlayerHandle {
  seek(ms: number): void;
  pause(): void;
  getTimeMs(): number;
}

export interface Marker {
  id: string;
  timeMs: number;
  tone: "client" | "editor" | "ai";
  resolved: boolean;
  label: string;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

export function ReviewPlayer({
  ref,
  src,
  poster,
  frameRate,
  durationHintMs,
  markers,
  selectedMarkerId,
  onMarkerClick,
  annotation,
  drawing,
  drawColor,
  onAnnotationChange,
  onTime,
  onPlayingChange,
  onMediaError,
}: {
  ref?: React.Ref<PlayerHandle>;
  src: string | null;
  poster?: string | null;
  frameRate: number | null;
  durationHintMs: number | null;
  markers: Marker[];
  selectedMarkerId: string | null;
  onMarkerClick: (id: string) => void;
  annotation: AnnotationStroke[];
  drawing: boolean;
  drawColor: string;
  onAnnotationChange: (s: AnnotationStroke[]) => void;
  onTime?: (ms: number) => void;
  onPlayingChange?: (playing: boolean) => void;
  onMediaError?: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);
  const [durationMs, setDurationMs] = useState(durationHintMs ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [rate, setRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const scrubbing = useRef(false);
  const fps = frameRate && frameRate > 0 ? frameRate : 30;

  useImperativeHandle(ref, () => ({
    seek(ms: number) {
      const v = videoRef.current;
      if (!v) return;
      v.currentTime = Math.max(0, ms / 1000);
      setTimeMs(ms);
    },
    pause() {
      videoRef.current?.pause();
    },
    getTimeMs() {
      return Math.round((videoRef.current?.currentTime ?? 0) * 1000);
    },
  }));

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const stepFrames = useCallback(
    (n: number) => {
      const v = videoRef.current;
      if (!v) return;
      v.pause();
      v.currentTime = Math.min(Math.max(0, v.currentTime + n / fps), v.duration || Infinity);
    },
    [fps],
  );

  const seekBy = useCallback((sec: number) => {
    const v = videoRef.current;
    if (v) v.currentTime = Math.min(Math.max(0, v.currentTime + sec), v.duration || Infinity);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    else wrapRef.current?.requestFullscreen?.().catch(() => undefined);
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === " " || e.key === "k") {
        e.preventDefault();
        togglePlay();
      } else if (e.key === ",") stepFrames(-1);
      else if (e.key === ".") stepFrames(1);
      else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seekBy(e.shiftKey ? -5 : -1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seekBy(e.shiftKey ? 5 : 1);
      } else if (e.key === "j") seekBy(-5);
      else if (e.key === "l") seekBy(5);
      else if (e.key === "f") toggleFullscreen();
      else if (e.key === "m") setMuted((m) => !m);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, stepFrames, seekBy, toggleFullscreen]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = rate;
  }, [rate]);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = volume;
    v.muted = muted;
  }, [volume, muted]);

  // Smooth time display while playing.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = videoRef.current;
      if (v && !scrubbing.current) {
        const ms = Math.round(v.currentTime * 1000);
        setTimeMs(ms);
        onTime?.(ms);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, onTime]);

  useEffect(() => {
    setError(null);
  }, [src]);

  const ratioFromEvent = (clientX: number) => {
    const b = trackRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - b.left) / b.width));
  };
  const seekToRatio = (r: number) => {
    const v = videoRef.current;
    if (!v || !durationMs) return;
    const ms = Math.round(r * durationMs);
    v.currentTime = ms / 1000;
    setTimeMs(ms);
    onTime?.(ms);
  };

  const pct = durationMs ? (timeMs / durationMs) * 100 : 0;

  return (
    <div ref={wrapRef} className={cn("flex h-full min-h-0 flex-col bg-black", fullscreen && "h-screen")}>
      <div className="relative min-h-0 flex-1" onDoubleClick={toggleFullscreen}>
        {src ? (
          <video
            ref={videoRef}
            src={src}
            poster={poster ?? undefined}
            className="absolute inset-0 size-full object-contain"
            playsInline
            preload="metadata"
            onClick={() => !drawing && togglePlay()}
            onPlay={() => {
              setPlaying(true);
              onPlayingChange?.(true);
            }}
            onPause={() => {
              setPlaying(false);
              onPlayingChange?.(false);
              const ms = Math.round((videoRef.current?.currentTime ?? 0) * 1000);
              setTimeMs(ms);
              onTime?.(ms);
            }}
            onTimeUpdate={(e) => {
              if (!playing && !scrubbing.current) {
                const ms = Math.round(e.currentTarget.currentTime * 1000);
                setTimeMs(ms);
                onTime?.(ms);
              }
            }}
            onSeeked={(e) => {
              const ms = Math.round(e.currentTarget.currentTime * 1000);
              setTimeMs(ms);
              onTime?.(ms);
            }}
            onLoadedMetadata={(e) => {
              const d = e.currentTarget.duration;
              if (Number.isFinite(d)) setDurationMs(Math.round(d * 1000));
              if (!e.currentTarget.videoWidth) setError("This browser cannot decode the video track (unsupported codec).");
            }}
            onProgress={(e) => {
              const v = e.currentTarget;
              if (v.buffered.length && v.duration) setBuffered((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
            }}
            onWaiting={() => setWaiting(true)}
            onPlaying={() => setWaiting(false)}
            onCanPlay={() => setWaiting(false)}
            onError={(e) => {
              const code = e.currentTarget.error?.code;
              setError(
                code === 4
                  ? "This browser cannot play this file (unsupported format or codec). Ask the editor for an H.264 MP4."
                  : "The video could not be loaded. Retrying with a fresh link…",
              );
              if (code !== 4) onMediaError?.();
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/60">No playable version</div>
        )}
        <AnnotationLayer videoRef={videoRef} strokes={annotation} drawing={drawing} color={drawColor} onChange={onAnnotationChange} />
        {waiting && !error && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Loader2 className="size-8 animate-spin text-white/70" />
          </div>
        )}
        {error && (
          <div className="absolute inset-x-4 top-4 flex items-start gap-2 rounded-md bg-black/80 px-3 py-2 text-sm text-warning ring-1 ring-warning/30">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {error}
          </div>
        )}
        {drawing && (
          <div className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 rounded-full bg-black/75 px-3 py-1 text-xs text-white">
            Drawing on frame {formatTimecode(timeMs)}: drag to mark the area
          </div>
        )}
      </div>

      {/* Timeline */}
      <div className="border-t border-white/10 bg-panel px-3 pt-3 pb-2 select-none">
        <div
          ref={trackRef}
          className="timeline-track group relative h-6 cursor-pointer"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).dataset.marker) return;
            scrubbing.current = true;
            e.currentTarget.setPointerCapture(e.pointerId);
            seekToRatio(ratioFromEvent(e.clientX));
          }}
          onPointerMove={(e) => {
            const r = ratioFromEvent(e.clientX);
            const b = trackRef.current!.getBoundingClientRect();
            setHover({ x: r * b.width, ms: Math.round(r * durationMs) });
            if (scrubbing.current) seekToRatio(r);
          }}
          onPointerUp={() => (scrubbing.current = false)}
          onPointerLeave={() => setHover(null)}
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={durationMs}
          aria-valuenow={timeMs}
          aria-valuetext={formatTimecode(timeMs)}
          tabIndex={0}
        >
          <div className="absolute inset-x-0 top-[17px] h-1 rounded-full bg-white/10">
            <div className="absolute inset-y-0 left-0 rounded-full bg-white/15" style={{ width: `${buffered}%` }} />
            <div className="absolute inset-y-0 left-0 rounded-full bg-primary" style={{ width: `${pct}%` }} />
          </div>
          <div className="absolute top-[13px] size-3 -translate-x-1/2 rounded-full bg-white shadow" style={{ left: `${pct}%` }} />
          {markers.map((m) => (
            <Tooltip key={m.id}>
              <TooltipTrigger
                render={
                  <button
                    data-marker="1"
                    aria-label={`Comment at ${formatTimecode(m.timeMs)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onMarkerClick(m.id);
                    }}
                    className={cn(
                      "absolute top-0 size-3 -translate-x-1/2 rounded-full ring-2 ring-panel transition-transform hover:scale-125",
                      m.tone === "client" ? "bg-client" : m.tone === "editor" ? "bg-editor" : "bg-ai",
                      m.resolved && "opacity-35",
                      selectedMarkerId === m.id && "scale-150 ring-white",
                    )}
                    style={{ left: `${durationMs ? Math.min(100, (m.timeMs / durationMs) * 100) : 0}%` }}
                  />
                }
              />
              <TooltipContent>
                {formatTimecode(m.timeMs)} · {m.label}
              </TooltipContent>
            </Tooltip>
          ))}
          {hover && (
            <div
              className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-black/85 px-1.5 py-0.5 text-[10px] text-white tabular"
              style={{ left: hover.x }}
            >
              {formatTimecode(hover.ms)}
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="mt-1 flex flex-wrap items-center gap-1 text-white/90">
          <button onClick={togglePlay} className="rounded-md p-1.5 hover:bg-white/10" aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </button>
          <Tooltip>
            <TooltipTrigger
              render={
                <button onClick={() => stepFrames(-1)} className="rounded-md p-1.5 hover:bg-white/10" aria-label="Previous frame">
                  <ChevronLeft className="size-4" />
                </button>
              }
            />
            <TooltipContent>Previous frame ( , ){frameRate ? "" : " · assumes 30 fps"}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button onClick={() => stepFrames(1)} className="rounded-md p-1.5 hover:bg-white/10" aria-label="Next frame">
                  <ChevronRight className="size-4" />
                </button>
              }
            />
            <TooltipContent>Next frame ( . ){frameRate ? "" : " · assumes 30 fps"}</TooltipContent>
          </Tooltip>
          <span className="ml-1 font-mono text-xs tabular">
            {formatTimecode(timeMs)} <span className="text-white/40">/ {formatTimecode(durationMs)}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button onClick={() => setMuted((m) => !m)} className="rounded-md p-1.5 hover:bg-white/10" aria-label={muted ? "Unmute" : "Mute"}>
              {muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                setMuted(false);
              }}
              aria-label="Volume"
              className="hidden w-20 accent-primary sm:block"
            />
            <select
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              aria-label="Playback speed"
              className="h-7 rounded-md bg-transparent px-1 text-xs hover:bg-white/10"
            >
              {SPEEDS.map((s) => (
                <option key={s} value={s} className="bg-popover">
                  {s}×
                </option>
              ))}
            </select>
            {frameRate ? <span className="hidden text-[11px] text-white/40 sm:inline">{Math.round(frameRate * 100) / 100} fps</span> : null}
            <button onClick={toggleFullscreen} className="rounded-md p-1.5 hover:bg-white/10" aria-label="Fullscreen">
              {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
