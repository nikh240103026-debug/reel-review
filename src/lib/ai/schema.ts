import { z } from "zod";
import { OP_TYPES, POSITIONS, type OpType } from "@/shared/operations";

/**
 * The "wire" schema an AI provider must return (enforced by structured outputs).
 * It is intentionally loose on numeric ranges: range/domain checks happen in
 * our own validation so that an out-of-range value marks one operation
 * invalid (visible to the editor) instead of discarding the whole proposal.
 */

const WIRE_PARAMS = {
  text_resize: z.object({ layer_hint: z.string(), scale_percent: z.number() }),
  layer_move: z.object({ layer_hint: z.string(), dx_percent: z.number(), dy_percent: z.number() }),
  layer_extend: z.object({ layer_hint: z.string(), extend_by_ms: z.number().int() }),
  text_replace: z.object({ layer_hint: z.string(), new_text: z.string() }),
  clip_trim: z.object({ mode: z.enum(["remove_range", "keep_range"]) }),
  clip_split: z.object({}),
  audio_gain: z.object({ gain_db: z.number() }),
  text_overlay_add: z.object({
    text: z.string(),
    position: z.enum(POSITIONS),
    font_size_percent: z.number(),
    color: z.string().describe("Hex colour such as #FFFFFF"),
  }),
  manual_instruction: z.object({ instruction: z.string() }),
} satisfies Record<OpType, z.ZodType>;

const common = {
  operation_id: z.string().describe("Short unique id within this proposal, e.g. op_1"),
  source_comment_ids: z.array(z.string()).describe("Exact ids of the comments this operation addresses"),
  start_ms: z.number().int().describe("Target start (or single point) in integer milliseconds on the source version"),
  end_ms: z.number().int().nullable().describe("Target end in integer milliseconds, or null for a single point"),
  explanation: z.string().describe("Plain-language explanation for the editor of what will change and why"),
  confidence: z.number().describe("0..1 confidence that this operation is what the commenter asked for"),
  uncertainty: z.string().nullable().describe("What you are unsure about, or null"),
  needs_clarification: z.boolean().describe("true if the request is ambiguous and must not be executed as-is"),
  clarification_question: z.string().nullable().describe("Question to ask the commenter when needs_clarification is true"),
};

const variants = OP_TYPES.map((t) =>
  z.object({ ...common, operation_type: z.literal(t), params: WIRE_PARAMS[t] }),
) as unknown as [z.ZodObject, z.ZodObject, ...z.ZodObject[]];

export const WireOperation = z.discriminatedUnion("operation_type", variants);

export const WireProposal = z.object({
  summary: z.string().describe("2-4 sentence overview of the proposed edits for the editor"),
  operations: z.array(WireOperation),
  comment_coverage: z
    .array(
      z.object({
        comment_id: z.string(),
        status: z.enum(["addressed", "needs_clarification", "not_actionable"]),
        note: z.string(),
      }),
    )
    .describe("One entry for every comment provided, explaining how it was handled"),
});

export interface WireOperationT {
  operation_id: string;
  source_comment_ids: string[];
  start_ms: number;
  end_ms: number | null;
  explanation: string;
  confidence: number;
  uncertainty: string | null;
  needs_clarification: boolean;
  clarification_question: string | null;
  operation_type: OpType;
  params: Record<string, unknown>;
}

export interface WireProposalT {
  summary: string;
  operations: WireOperationT[];
  comment_coverage: { comment_id: string; status: "addressed" | "needs_clarification" | "not_actionable"; note: string }[];
}
