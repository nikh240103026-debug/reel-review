import { z } from "zod";

/**
 * The closed catalog of edit operations. Claude may only propose these, the
 * server validates them, and agents execute only what their adapter declares.
 * No operation ever carries executable code or shell commands.
 *
 * Shared by the web app (server + client) and the local agent.
 */

export const OP_TYPES = [
  "text_resize",
  "layer_move",
  "layer_extend",
  "text_replace",
  "clip_trim",
  "clip_split",
  "audio_gain",
  "text_overlay_add",
  "manual_instruction",
] as const;
export type OpType = (typeof OP_TYPES)[number];

export const POSITIONS = [
  "top_left",
  "top",
  "top_right",
  "left",
  "center",
  "right",
  "bottom_left",
  "bottom",
  "bottom_right",
] as const;

/** Strict parameter schemas, enforced server-side and by agents. */
export const PARAM_SCHEMAS = {
  text_resize: z
    .object({
      layer_hint: z.string().min(1).max(200),
      scale_percent: z.number().min(10).max(500),
    })
    .strict(),
  layer_move: z
    .object({
      layer_hint: z.string().min(1).max(200),
      dx_percent: z.number().min(-100).max(100),
      dy_percent: z.number().min(-100).max(100),
    })
    .strict(),
  layer_extend: z
    .object({
      layer_hint: z.string().min(1).max(200),
      extend_by_ms: z.number().int().min(-600_000).max(600_000).refine((v) => v !== 0, "must not be zero"),
    })
    .strict(),
  text_replace: z
    .object({
      layer_hint: z.string().min(1).max(200),
      new_text: z.string().min(1).max(500),
    })
    .strict(),
  clip_trim: z.object({ mode: z.enum(["remove_range", "keep_range"]) }).strict(),
  clip_split: z.object({}).strict(),
  audio_gain: z.object({ gain_db: z.number().min(-60).max(24) }).strict(),
  text_overlay_add: z
    .object({
      text: z.string().min(1).max(300),
      position: z.enum(POSITIONS),
      font_size_percent: z.number().min(1).max(25),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    })
    .strict(),
  manual_instruction: z.object({ instruction: z.string().min(1).max(2000) }).strict(),
} satisfies Record<OpType, z.ZodType>;

/** Whether the op needs a time range (end_ms) or a single point. */
export const TIME_SHAPE: Record<OpType, "range" | "point" | "either"> = {
  text_resize: "either",
  layer_move: "either",
  layer_extend: "either",
  text_replace: "either",
  clip_trim: "range",
  clip_split: "point",
  audio_gain: "range",
  text_overlay_add: "range",
  manual_instruction: "either",
};

export const OP_LABELS: Record<OpType, string> = {
  text_resize: "Resize text layer",
  layer_move: "Move layer",
  layer_extend: "Extend / shorten layer",
  text_replace: "Change text content",
  clip_trim: "Trim range",
  clip_split: "Split clip",
  audio_gain: "Adjust audio level",
  text_overlay_add: "Add text overlay",
  manual_instruction: "Manual instruction",
};

export const OP_DESCRIPTIONS: Record<OpType, string> = {
  text_resize: "Scale an identified text/title layer. scale_percent 100 = unchanged.",
  layer_move: "Move an identified graphic/text layer by a percentage of frame width/height (negative dx = left, negative dy = up).",
  layer_extend: "Lengthen (positive) or shorten (negative) an identified layer's duration by extend_by_ms.",
  text_replace: "Replace the content of an identified text layer.",
  clip_trim: "Remove the target range from the edit (remove_range) or keep only the target range (keep_range).",
  clip_split: "Split the clip at target start_ms.",
  audio_gain: "Change audio level by gain_db across the target range.",
  text_overlay_add: "Burn a new text overlay into the target range.",
  manual_instruction: "A precise instruction for a human editor when no automated operation fits.",
};

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export const ADAPTER_IDS = ["manual", "ffmpeg", "premiere_pro", "after_effects", "davinci_resolve"] as const;
export type AdapterId = (typeof ADAPTER_IDS)[number];

export interface AdapterInfo {
  id: AdapterId;
  label: string;
  /** false = scaffold only; never selectable for execution */
  implemented: boolean;
  automated: boolean;
  supportedOps: OpType[];
  summary: string;
  limitations: string[];
}

export const ADAPTERS: Record<AdapterId, AdapterInfo> = {
  manual: {
    id: "manual",
    label: "Manual checklist",
    implemented: true,
    automated: false,
    supportedOps: [...OP_TYPES],
    summary:
      "Turns approved operations into a checklist on the editing machine. A human performs each edit; completion is tracked per task.",
    limitations: ["Nothing is changed automatically.", "A render must be exported by the editor (dropped in the job folder or uploaded in the web app)."],
  },
  ffmpeg: {
    id: "ffmpeg",
    label: "FFmpeg (flattened render)",
    implemented: true,
    automated: true,
    supportedOps: ["clip_trim", "audio_gain", "text_overlay_add"],
    summary:
      "Applies supported operations directly to the rendered source video with FFmpeg and uploads a new render.",
    limitations: [
      "Works on the flattened video file, not on editor project files.",
      "Cannot resize, move or retime existing layers that are already baked into the picture.",
    ],
  },
  premiere_pro: {
    id: "premiere_pro",
    label: "Premiere Pro (FFmpeg render + review)",
    implemented: true,
    automated: true,
    supportedOps: ["clip_trim", "audio_gain", "text_overlay_add"],
    summary: "Renders approved flattened-video edits with FFmpeg, then opens the new render in Premiere Pro for human review.",
    limitations: ["Edits are applied to the flattened video, not to an existing Premiere project or its layers.", "Requires FFmpeg and Premiere Pro on the agent device."],
  },
  after_effects: {
    id: "after_effects",
    label: "After Effects (FFmpeg render + review)",
    implemented: true,
    automated: true,
    supportedOps: ["clip_trim", "audio_gain", "text_overlay_add"],
    summary: "Renders approved flattened-video edits with FFmpeg, then opens the new render in After Effects for human review.",
    limitations: ["Edits are applied to the flattened video, not to an existing After Effects project or its layers.", "Requires FFmpeg and After Effects on the agent device."],
  },
  davinci_resolve: {
    id: "davinci_resolve",
    label: "DaVinci Resolve (FFmpeg render + review)",
    implemented: true,
    automated: true,
    supportedOps: ["clip_trim", "audio_gain", "text_overlay_add"],
    summary: "Renders approved flattened-video edits with FFmpeg, then opens the new render in Resolve for human review.",
    limitations: ["Edits are applied to the flattened video, not to an existing Resolve project or its layers.", "Requires FFmpeg and DaVinci Resolve on the agent device."],
  },
};

export function adapterSupports(adapter: AdapterId, op: OpType): boolean {
  const info = ADAPTERS[adapter];
  return info.implemented && info.supportedOps.includes(op);
}

export function compatibilityFor(op: OpType): Record<AdapterId, boolean> {
  return Object.fromEntries(ADAPTER_IDS.map((a) => [a, adapterSupports(a, op)])) as Record<AdapterId, boolean>;
}

// ---------------------------------------------------------------------------
// Validation shared by server and agent
// ---------------------------------------------------------------------------

export interface OperationInput {
  op_type: string;
  start_ms: number;
  end_ms: number | null;
  params: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateOperationShape(op: OperationInput, durationMs: number | null): ValidationResult {
  const errors: string[] = [];
  if (!(OP_TYPES as readonly string[]).includes(op.op_type)) {
    return { ok: false, errors: [`Unknown operation type "${op.op_type}"`] };
  }
  const type = op.op_type as OpType;
  const parsed = PARAM_SCHEMAS[type].safeParse(op.params);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`params${issue.path.length ? "." + issue.path.join(".") : ""}: ${issue.message}`);
    }
  }
  if (!Number.isInteger(op.start_ms) || op.start_ms < 0) errors.push("start_ms must be a non-negative integer");
  if (op.end_ms !== null && (!Number.isInteger(op.end_ms) || op.end_ms <= op.start_ms)) {
    errors.push("end_ms must be an integer greater than start_ms");
  }
  const shape = TIME_SHAPE[type];
  if (shape === "range" && op.end_ms === null) errors.push(`${type} requires a time range (end_ms)`);
  if (shape === "point" && op.end_ms !== null) errors.push(`${type} takes a single point in time (end_ms must be null)`);
  if (durationMs !== null && durationMs > 0) {
    if (op.start_ms > durationMs) errors.push(`start_ms ${op.start_ms} is beyond the video duration (${durationMs} ms)`);
    if (op.end_ms !== null && op.end_ms > durationMs + 50) {
      errors.push(`end_ms ${op.end_ms} is beyond the video duration (${durationMs} ms)`);
    }
  }
  if (type === "clip_trim" && parsed.success && durationMs) {
    const p = parsed.data as { mode: string };
    if (p.mode === "remove_range" && op.start_ms <= 0 && op.end_ms !== null && op.end_ms >= durationMs) {
      errors.push("clip_trim would remove the entire video");
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Agent protocol payloads
// ---------------------------------------------------------------------------

export interface AgentJobOperation {
  id: string;
  op_key: string;
  op_type: OpType;
  start_ms: number;
  end_ms: number | null;
  params: Record<string, unknown>;
  explanation: string;
  execution_status?: string;
  source_comments: { id: string; author_name: string; body: string; timestamp_ms: number | null }[];
}

export interface AgentJobPayload {
  job: {
    id: string;
    adapter: AdapterId;
    attempt: number;
    max_attempts: number;
    lease_expires_at: string;
    approved_hash: string;
  };
  project: { id: string; name: string };
  video: { id: string; title: string };
  source_version: {
    id: string;
    version_number: number;
    download_url: string;
    content_type: string;
    size_bytes: number;
    duration_ms: number | null;
    width: number | null;
    height: number | null;
    frame_rate: number | null;
    original_filename: string;
  };
  operations: AgentJobOperation[];
}

export const ExecutionStatus = z.enum(["pending", "running", "done", "failed", "skipped", "manual_pending", "manual_done"]);

// ---------------------------------------------------------------------------
// UI metadata for editing typed parameters
// ---------------------------------------------------------------------------

export type ParamField =
  | { key: string; label: string; kind: "number"; min: number; max: number; step: number; unit?: string }
  | { key: string; label: string; kind: "text" | "textarea" }
  | { key: string; label: string; kind: "enum"; options: readonly string[] }
  | { key: string; label: string; kind: "color" };

export const PARAM_FIELDS: Record<OpType, ParamField[]> = {
  text_resize: [
    { key: "layer_hint", label: "Target layer", kind: "text" },
    { key: "scale_percent", label: "Scale", kind: "number", min: 10, max: 500, step: 1, unit: "%" },
  ],
  layer_move: [
    { key: "layer_hint", label: "Target layer", kind: "text" },
    { key: "dx_percent", label: "Move horizontally", kind: "number", min: -100, max: 100, step: 0.5, unit: "% width" },
    { key: "dy_percent", label: "Move vertically", kind: "number", min: -100, max: 100, step: 0.5, unit: "% height" },
  ],
  layer_extend: [
    { key: "layer_hint", label: "Target layer", kind: "text" },
    { key: "extend_by_ms", label: "Extend by", kind: "number", min: -600000, max: 600000, step: 100, unit: "ms" },
  ],
  text_replace: [
    { key: "layer_hint", label: "Target layer", kind: "text" },
    { key: "new_text", label: "New text", kind: "textarea" },
  ],
  clip_trim: [{ key: "mode", label: "Mode", kind: "enum", options: ["remove_range", "keep_range"] }],
  clip_split: [],
  audio_gain: [{ key: "gain_db", label: "Gain", kind: "number", min: -60, max: 24, step: 0.5, unit: "dB" }],
  text_overlay_add: [
    { key: "text", label: "Text", kind: "textarea" },
    { key: "position", label: "Position", kind: "enum", options: POSITIONS },
    { key: "font_size_percent", label: "Font size", kind: "number", min: 1, max: 25, step: 0.5, unit: "% height" },
    { key: "color", label: "Colour", kind: "color" },
  ],
  manual_instruction: [{ key: "instruction", label: "Instruction", kind: "textarea" }],
};

/** Reasonable starting params when the editor switches an operation's type. */
export function defaultParams(t: OpType): Record<string, unknown> {
  switch (t) {
    case "text_resize":
      return { layer_hint: "", scale_percent: 120 };
    case "layer_move":
      return { layer_hint: "", dx_percent: 0, dy_percent: 0 };
    case "layer_extend":
      return { layer_hint: "", extend_by_ms: 1000 };
    case "text_replace":
      return { layer_hint: "", new_text: "" };
    case "clip_trim":
      return { mode: "remove_range" };
    case "clip_split":
      return {};
    case "audio_gain":
      return { gain_db: -6 };
    case "text_overlay_add":
      return { text: "", position: "bottom", font_size_percent: 5, color: "#FFFFFF" };
    case "manual_instruction":
      return { instruction: "" };
  }
}
