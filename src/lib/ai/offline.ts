import type { ReviewInput } from "./prompt";
import type { WireProposalT } from "./schema";

/**
 * OFFLINE DRAFT MODE — NOT AI.
 * Used only when the editor explicitly chooses it (e.g. no Claude API key).
 * Each actionable comment becomes a manual_instruction that quotes the
 * comment verbatim. No interpretation, no layer identification, no guessing.
 */
export function offlineDraft(input: ReviewInput): WireProposalT {
  const operations: WireProposalT["operations"] = [];
  const coverage: WireProposalT["comment_coverage"] = [];
  let n = 0;
  for (const c of input.comments) {
    const thread = [c.body, ...c.replies.map((r) => `${r.author_name}: ${r.body}`)].join("\n");
    if (c.timestamp_ms === null) {
      coverage.push({ comment_id: c.id, status: "not_actionable", note: "No timestamp." });
      continue;
    }
    n += 1;
    operations.push({
      operation_id: `op_${n}`,
      source_comment_ids: [c.id],
      start_ms: c.timestamp_ms,
      end_ms: null,
      operation_type: "manual_instruction",
      params: {
        instruction: `At ${(c.timestamp_ms / 1000).toFixed(2)}s, ${c.author_name} wrote: "${thread.slice(0, 1800)}"`,
      },
      explanation:
        "Offline draft (no AI): the comment is copied verbatim as a manual task. Nothing was interpreted; the editor must decide what to change.",
      confidence: 0.5,
      uncertainty: "Not analyzed by an AI model.",
      needs_clarification: false,
      clarification_question: null,
    });
    coverage.push({ comment_id: c.id, status: "addressed", note: "Copied verbatim into a manual instruction." });
  }
  return {
    summary: `Offline draft generated without AI from ${input.comments.length} unresolved comment(s). Each comment is a manual checklist item quoted verbatim.`,
    operations,
    comment_coverage: coverage,
  };
}
