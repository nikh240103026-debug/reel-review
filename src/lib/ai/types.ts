import type { WireProposalT } from "./schema";

export interface AnalysisResult {
  proposal: WireProposalT;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}
