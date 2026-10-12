import { describe, it, expect, beforeAll, vi } from "vitest";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { EDITOR, freshDb, getDb, setupProjectWithVideo } from "./helpers";
import { createComment } from "@/lib/services/comments";
import {
  approveProposal,
  changeAdapter,
  createRevision,
  decideOperation,
  editOperation,
  generateProposal,
  getProposal,
} from "@/lib/services/proposals";
import { queueJob } from "@/lib/services/jobs";
import { WireProposal, type WireProposalT } from "@/lib/ai/schema";
import { HttpError } from "@/lib/http";

// Claude is mocked: this environment has no API key. The mock returns what a
// model could return, including ambiguous and invalid operations, so the
// server-side validation and approval logic is exercised for real.
const mockState: { next: ((ids: string[]) => WireProposalT) | null } = { next: null };
vi.mock("@/lib/ai/claude", () => ({
  AiError: class AiError extends Error {},
  analyzeWithClaude: vi.fn(async (input: { comments: { id: string }[] }) => ({
    proposal: mockState.next!(input.comments.map((c) => c.id)),
    model: "claude-opus-5-5",
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: "end_turn",
  })),
}));

async function expectHttp(p: Promise<unknown>, status: number) {
  const err = await p.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  return err as HttpError;
}

describe("AI proposals and approval", () => {
  let videoId: string, versionId: string;
  let headline: string, music: string, vague: string;

  beforeAll(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-used";
    await freshDb();
    ({ videoId, versionId } = await setupProjectWithVideo());
    const base = { videoId, versionId, authorType: "client" as const, authorName: "Alex" };
    headline = await createComment({ ...base, body: "Make this headline bigger and move it to the left.", timestampMs: 1200 });
    music = await createComment({ ...base, body: "Music is too loud between 2 and 4 seconds.", timestampMs: 2000 });
    vague = await createComment({ ...base, body: "Make it pop more.", timestampMs: 4500 });
  });

  it("wire schema converts to a structured-output JSON schema", () => {
    const fmt = betaZodOutputFormat(WireProposal);
    expect(fmt.type).toBe("json_schema");
    expect(JSON.stringify(fmt.schema)).toContain("operation_type");
  });

  it("(9)(13) validates Claude output: valid, ambiguous, unsupported and out-of-range operations are labelled", async () => {
    mockState.next = () => ({
      summary: "Enlarge and move the headline, lower music, clarify vague note.",
      operations: [
        {
          operation_id: "op_1", source_comment_ids: [headline], start_ms: 1200, end_ms: null, operation_type: "text_resize",
          params: { layer_hint: "headline", scale_percent: 130 }, explanation: "Scale headline 130%", confidence: 0.8,
          uncertainty: null, needs_clarification: false, clarification_question: null,
        },
        {
          operation_id: "op_2", source_comment_ids: [music], start_ms: 2000, end_ms: 4000, operation_type: "audio_gain",
          params: { gain_db: -6 }, explanation: "Lower music 6 dB", confidence: 0.9, uncertainty: null,
          needs_clarification: false, clarification_question: null,
        },
        {
          operation_id: "op_3", source_comment_ids: [vague], start_ms: 4500, end_ms: null, operation_type: "manual_instruction",
          params: { instruction: "Unclear request" }, explanation: "Ambiguous", confidence: 0.2, uncertainty: "What should pop?",
          needs_clarification: true, clarification_question: "Which element should stand out more: the text, colour or pacing?",
        },
        {
          operation_id: "op_4", source_comment_ids: [music], start_ms: 2000, end_ms: 4000, operation_type: "audio_gain",
          params: { gain_db: -95 }, explanation: "Out of range", confidence: 0.3, uncertainty: null,
          needs_clarification: false, clarification_question: null,
        },
        {
          operation_id: "op_5", source_comment_ids: ["00000000-0000-4000-8000-00000000dead"], start_ms: 100, end_ms: null,
          operation_type: "manual_instruction", params: { instruction: "Hallucinated" }, explanation: "x", confidence: 0.5,
          uncertainty: null, needs_clarification: false, clarification_question: null,
        },
      ],
      comment_coverage: [
        { comment_id: headline, status: "addressed", note: "" },
        { comment_id: music, status: "addressed", note: "" },
        { comment_id: vague, status: "needs_clarification", note: "Vague" },
      ],
    });
    const id = await generateProposal(videoId, { versionId, adapter: "ffmpeg", mode: "claude" }, EDITOR);
    const { proposal, history } = await getProposal(id);
    const by = Object.fromEntries(proposal.operations!.map((o) => [o.op_key, o]));
    expect(proposal.generator).toBe("claude");
    expect(proposal.status).toBe("needs_clarification");
    expect(by.op_1!.validation_status).toBe("unsupported"); // ffmpeg cannot resize layers
    expect(by.op_1!.adapter_compat).toMatchObject({ manual: true, ffmpeg: false });
    expect(by.op_2!.validation_status).toBe("valid");
    expect(by.op_3!.validation_status).toBe("needs_clarification");
    expect(by.op_4!.validation_status).toBe("invalid");
    expect(by.op_4!.validation_errors.join(" ")).toMatch(/gain_db/);
    expect(by.op_5!.validation_status).toBe("invalid");
    expect(history.map((h) => h.event_type)).toEqual(
      expect.arrayContaining(["proposal.created", "proposal.validated", "proposal.needs_clarification"]),
    );

    // unsupported / ambiguous / invalid operations cannot be approved
    await expectHttp(decideOperation(id, by.op_1!.id, "approved", EDITOR), 409);
    await expectHttp(decideOperation(id, by.op_3!.id, "approved", EDITOR), 409);
    await expectHttp(decideOperation(id, by.op_4!.id, "approved", EDITOR), 409);
    // nothing has been "applied": no jobs exist and execution status untouched
    const db = await getDb();
    const [{ n }] = (await db.query<{ n: number }>("select count(*)::int as n from edit_jobs")) as [{ n: number }];
    expect(n).toBe(0);
    expect(proposal.operations!.every((o) => o.execution_status === "not_started")).toBe(true);
  });

  it("(10)(11) approval is bound to an exact revision; edits invalidate it; unapproved work cannot be queued", async () => {
    mockState.next = () => ({
      summary: "Lower music",
      operations: [
        {
          operation_id: "op_1", source_comment_ids: [music], start_ms: 2000, end_ms: 4000, operation_type: "audio_gain",
          params: { gain_db: -6 }, explanation: "Lower music", confidence: 0.9, uncertainty: null,
          needs_clarification: false, clarification_question: null,
        },
        {
          operation_id: "op_2", source_comment_ids: [headline], start_ms: 1200, end_ms: 3000, operation_type: "text_overlay_add",
          params: { text: "SALE", position: "top_left", font_size_percent: 8, color: "#FFFFFF" }, explanation: "Add text",
          confidence: 0.6, uncertainty: null, needs_clarification: false, clarification_question: null,
        },
      ],
      comment_coverage: [{ comment_id: music, status: "addressed", note: "" }],
    });
    const id = await generateProposal(videoId, { versionId, adapter: "ffmpeg", mode: "claude" }, EDITOR);
    let { proposal } = await getProposal(id);
    expect(proposal.status).toBe("awaiting_approval");
    const [a, b] = proposal.operations!;

    // cannot queue before approval
    await expectHttp(queueJob(id, {}, EDITOR), 409);
    // cannot approve with undecided operations
    await expectHttp(approveProposal(id, proposal.content_hash!, EDITOR), 409);

    await decideOperation(id, a!.id, "approved", EDITOR);
    await decideOperation(id, b!.id, "approved", EDITOR);
    ({ proposal } = await getProposal(id));
    const reviewedHash = proposal.content_hash!;

    // editing a parameter resets that operation's approval and changes the hash
    await editOperation(id, b!.id, { params: { text: "BIG SALE", position: "top_left", font_size_percent: 8, color: "#FFFFFF" } }, EDITOR);
    ({ proposal } = await getProposal(id));
    expect(proposal.operations!.find((o) => o.id === b!.id)!.decision).toBe("pending");
    expect(proposal.content_hash).not.toBe(reviewedHash);
    // the stale hash the editor reviewed can no longer be approved
    await decideOperation(id, b!.id, "approved", EDITOR);
    await expectHttp(approveProposal(id, reviewedHash, EDITOR), 409);

    ({ proposal } = await getProposal(id));
    const { approved_hash } = await approveProposal(id, proposal.content_hash!, EDITOR);
    expect(approved_hash).toBe(proposal.content_hash);

    // once approved, the revision is frozen (service + database trigger)
    await expectHttp(editOperation(id, a!.id, { params: { gain_db: -12 } }, EDITOR), 409);
    await expectHttp(changeAdapter(id, "manual", EDITOR), 409);
    const db = await getDb();
    await expect(db.query("update edit_operations set params = '{\"gain_db\": -20}'::jsonb where id = $1", [a!.id])).rejects.toThrow(/approved proposal revision/);
    // jobs cannot be inserted without a matching approval (database trigger)
    await expect(
      db.query(
        `insert into edit_jobs (proposal_id, video_id, source_version_id, adapter, approved_hash, idempotency_key)
         values ($1, $2, $3, 'ffmpeg', $4, 'forged')`,
        [id, videoId, versionId, "0".repeat(64)],
      ),
    ).rejects.toThrow(/matching approval/);

    // queueing is idempotent for the same approval
    const job1 = await queueJob(id, {}, EDITOR);
    const job2 = await queueJob(id, {}, EDITOR);
    expect(job1).toBe(job2);

    // a new revision requires a new approval; the queued job of the old one is cancelled
    const rev2 = await createRevision(id, EDITOR);
    const r2 = await getProposal(rev2);
    expect(r2.proposal.revision).toBe(2);
    expect(r2.proposal.approved_hash).toBeNull();
    expect(r2.proposal.operations!.every((o) => o.decision === "pending")).toBe(true);
    const old = await getProposal(id);
    expect(old.proposal.status).toBe("cancelled");
    expect(old.jobs[0]!.status).toBe("cancelled");
  });

  it("offline draft is labelled as not AI and only produces manual instructions", async () => {
    const id = await generateProposal(videoId, { versionId, adapter: "manual", mode: "offline" }, EDITOR);
    const { proposal } = await getProposal(id);
    expect(proposal.generator).toBe("offline_rules");
    expect(proposal.model).toBeNull();
    expect(proposal.operations!.every((o) => o.op_type === "manual_instruction")).toBe(true);
    expect(proposal.operations!.length).toBe(3);
  });
});
