"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationStroke } from "@/shared/dto";

/** Computes the rectangle the video picture occupies inside its letterboxed element. */
function contentRect(video: HTMLVideoElement) {
  const ew = video.clientWidth;
  const eh = video.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  const scale = Math.min(ew / vw, eh / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}

export const ANNOTATION_COLORS = ["#FF4D4F", "#FFC53D", "#36CFC9", "#FFFFFF"];

/**
 * Canvas overlay aligned to the visible video picture. Shows saved strokes
 * and, in drawing mode, records new strokes in normalized (0..1) coordinates.
 */
export function AnnotationLayer({
  videoRef,
  strokes,
  drawing,
  color,
  onChange,
}: {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  strokes: AnnotationStroke[];
  drawing: boolean;
  color: string;
  onChange?: (s: AnnotationStroke[]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rect, setRect] = useState({ x: 0, y: 0, w: 0, h: 0 });
  const current = useRef<AnnotationStroke | null>(null);

  const measure = useCallback(() => {
    const v = videoRef.current;
    if (v) setRect(contentRect(v));
  }, [videoRef]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(v);
    v.addEventListener("loadedmetadata", measure);
    return () => {
      ro.disconnect();
      v.removeEventListener("loadedmetadata", measure);
    };
  }, [videoRef, measure]);

  const draw = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(rect.w * dpr));
    c.height = Math.max(1, Math.round(rect.h * dpr));
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.w, rect.h);
    const all = current.current ? [...strokes, current.current] : strokes;
    for (const s of all) {
      if (!s.points.length) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = Math.max(2, s.width * rect.w);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = 3;
      ctx.beginPath();
      s.points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x * rect.w, y * rect.h) : ctx.lineTo(x * rect.w, y * rect.h)));
      if (s.points.length === 1) ctx.lineTo(s.points[0]![0] * rect.w + 0.1, s.points[0]![1] * rect.h);
      ctx.stroke();
    }
  }, [rect, strokes]);

  useEffect(draw, [draw]);

  const point = (e: React.PointerEvent): [number, number] => {
    const b = canvasRef.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), Math.min(1, Math.max(0, (e.clientY - b.top) / b.height))];
  };

  if (!strokes.length && !drawing) return null;
  return (
    <canvas
      ref={canvasRef}
      className="absolute"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        cursor: drawing ? "crosshair" : "default",
        pointerEvents: drawing ? "auto" : "none",
        touchAction: "none",
        outline: drawing ? "1px dashed rgba(255,255,255,0.35)" : "none",
      }}
      onPointerDown={(e) => {
        if (!drawing) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        current.current = { color, width: 0.004, points: [point(e)] };
        draw();
      }}
      onPointerMove={(e) => {
        if (!drawing || !current.current) return;
        const p = point(e);
        const last = current.current.points[current.current.points.length - 1]!;
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.002 && current.current.points.length < 1000) {
          current.current.points.push([Math.round(p[0] * 10000) / 10000, Math.round(p[1] * 10000) / 10000]);
          draw();
        }
      }}
      onPointerUp={() => {
        if (!current.current) return;
        const s = current.current;
        current.current = null;
        if (strokes.length < 40) onChange?.([...strokes, s]);
      }}
    />
  );
}
