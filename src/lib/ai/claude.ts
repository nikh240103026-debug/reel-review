import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { SYSTEM_PROMPT, buildUserPrompt, type ReviewInput } from "./prompt";
import { WireProposal, type WireProposalT } from "./schema";

export class AiError extends Error {
  constructor(
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}

export interface ClaudeResult {
  proposal: WireProposalT;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}

/**
 * Calls Claude with structured outputs. The response is constrained to the
 * WireProposal JSON schema and validated again by the SDK's Zod parser.
 * Refusal fallbacks are enabled ("default" server-side routing).
 */
export async function analyzeWithClaude(input: ReviewInput, frames: { mediaType: "image/jpeg"; data: string }[]): Promise<ClaudeResult> {
  if (!env.anthropicConfigured) throw new AiError("ANTHROPIC_API_KEY is not configured");
  const client = new Anthropic({ maxRetries: 2, timeout: 5 * 60 * 1000 });

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const f of frames) {
    content.push({ type: "image", source: { type: "base64", media_type: f.mediaType, data: f.data } });
  }
  content.push({ type: "text", text: buildUserPrompt(input) });

  try {
    const response = await client.beta.messages.parse({
      model: env.anthropicModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: env.aiEffort, format: betaZodOutputFormat(WireProposal) },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      throw new AiError("Claude declined to analyze this feedback. Review the comments manually.");
    }
    if (response.stop_reason === "max_tokens") {
      throw new AiError("Claude's response was cut off before completing. Try again with fewer comments.", true);
    }
    const parsed = response.parsed_output as WireProposalT | null;
    if (!parsed) throw new AiError("Claude returned no structured output", true);
    log.info("ai.analysis_complete", {
      model: response.model,
      operations: parsed.operations.length,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    });
    return {
      proposal: parsed,
      model: response.model,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      stop_reason: response.stop_reason,
    };
  } catch (err) {
    if (err instanceof AiError) throw err;
    if (err instanceof Anthropic.AuthenticationError) throw new AiError("Claude API key was rejected (401). Check ANTHROPIC_API_KEY.");
    if (err instanceof Anthropic.PermissionDeniedError) throw new AiError("Claude API key lacks permission for this model (403).");
    if (err instanceof Anthropic.NotFoundError) throw new AiError(`Model "${env.anthropicModel}" was not found. Check ANTHROPIC_MODEL.`);
    if (err instanceof Anthropic.RateLimitError) throw new AiError("Claude API rate limit reached. Try again shortly.", true);
    if (err instanceof Anthropic.BadRequestError) throw new AiError(`Claude rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIConnectionError) throw new AiError("Could not reach the Claude API.", true);
    if (err instanceof Anthropic.APIError) throw new AiError(`Claude API error (${err.status ?? "unknown"}).`, true);
    if (err instanceof Anthropic.AnthropicError) {
      // structured-output parse failure from the SDK helper
      throw new AiError(`Claude's output failed schema validation: ${err.message.slice(0, 300)}`, true);
    }
    throw err;
  }
}
