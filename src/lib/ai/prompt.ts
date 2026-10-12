import { ADAPTERS, OP_DESCRIPTIONS, OP_TYPES, TIME_SHAPE, type AdapterId } from "@/shared/operations";
import type { AnnotationStroke } from "@/shared/dto";

export interface ReviewComment {
  id: string;
  author_name: string;
  author_type: string;
  timestamp_ms: number | null;
  body: string;
  annotation_regions: string[];
  replies: { id: string; author_name: string; author_type: string; body: string }[];
}

export interface ReviewInput {
  project: { name: string; description: string | null };
  video: { title: string };
  source_version: {
    id: string;
    version_number: number;
    duration_ms: number | null;
    width: number | null;
    height: number | null;
    frame_rate: number | null;
    has_audio: boolean | null;
  };
  adapter: AdapterId;
  comments: ReviewComment[];
  frames_attached: { comment_id: string; timestamp_ms: number }[];
}

export const SYSTEM_PROMPT = `You are the feedback analyst for a professional video editing agency. Clients leave timestamped review comments on a video version. Your job is to turn those comments into a structured, reviewable edit proposal that a human editor will inspect, modify, approve or reject before anything is executed.

Your output is a proposal, not an action. Nothing you produce is applied automatically, and you must never describe an edit as already done.

How to work:
- Use only the operation types in the catalog provided. Never output shell commands, scripts, code, file paths or editor-specific scripting. If no catalog operation fits, use manual_instruction with a precise, actionable instruction for a human editor.
- Prefer operation types the target adapter supports. If the best interpretation needs an operation the adapter cannot execute, still propose it (it will be flagged unsupported) or express it as a manual_instruction, and say so in the explanation.
- Times are integer milliseconds on the source version timeline. Anchor operations to the comment timestamp and keep them within the video duration. Use a range (end_ms) when the operation type requires one.
- When the comment does not let you identify the target with confidence (which layer, which word, how much, where exactly), do not guess: set needs_clarification to true, ask one specific question in clarification_question, and keep confidence low. Vague requests such as "make it pop" or "fix the audio" need clarification unless the context makes the intent unambiguous.
- layer_hint should describe the target as the commenter and any attached frame make it identifiable (e.g. "headline 'Summer Sale' top-left"), never invent layer names you cannot see evidence for.
- Comments that are praise, questions, or already-resolved discussion are not actionable; record them in comment_coverage as not_actionable.
- Replies can refine or contradict the original comment; the latest editor or client reply wins when they conflict.
- Every comment you are given must appear exactly once in comment_coverage, using its exact id. Every operation must reference the exact ids of the comments it addresses.
- Confidence is your honest probability (0..1) that the operation matches what the commenter wanted.`;

function describeCatalog(adapter: AdapterId): string {
  const info = ADAPTERS[adapter];
  const lines = OP_TYPES.map((t) => {
    const supported = info.supportedOps.includes(t) && info.implemented;
    return `- ${t} [${TIME_SHAPE[t]}${supported ? ", supported by target adapter" : ", NOT supported by target adapter"}]: ${OP_DESCRIPTIONS[t]}`;
  });
  return [
    `Target adapter: ${info.label} (${adapter}). ${info.summary}`,
    `Adapter limitations: ${info.limitations.join(" ")}`,
    "Operation catalog (time shape in brackets):",
    ...lines,
    "Parameter ranges: scale_percent 10-500; dx_percent/dy_percent -100..100 (percent of frame; negative dx = left, negative dy = up); extend_by_ms non-zero within ±600000; gain_db -60..24; font_size_percent 1-25 (percent of frame height); color as #RRGGBB.",
  ].join("\n");
}

export function buildUserPrompt(input: ReviewInput): string {
  const payload = {
    project: input.project,
    video: input.video,
    source_version: input.source_version,
    comments: input.comments,
    attached_frames: input.frames_attached.length
      ? input.frames_attached.map((f) => `Frame at ${f.timestamp_ms} ms for comment ${f.comment_id}`)
      : "No frames attached (server frame extraction unavailable).",
  };
  return `${describeCatalog(input.adapter)}

Review data (JSON):
${JSON.stringify(payload, null, 2)}

Produce the edit proposal for the unresolved comments above.`;
}

/** Converts normalized annotation strokes into a coarse region description. */
export function describeAnnotation(strokes: AnnotationStroke[] | undefined): string[] {
  if (!strokes?.length) return [];
  let minX = 1,
    minY = 1,
    maxX = 0,
    maxY = 0;
  for (const s of strokes) {
    for (const [x, y] of s.points) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return [
    `Commenter drew ${strokes.length} mark(s) covering x ${pct(minX)}–${pct(maxX)}, y ${pct(minY)}–${pct(maxY)} of the frame (origin top-left).`,
  ];
}
