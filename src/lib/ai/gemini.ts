import "server-only";
import { z } from "zod";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { SYSTEM_PROMPT, buildUserPrompt, type ReviewInput } from "./prompt";
import { WireProposal, type WireProposalT } from "./schema";
import { AiError } from "./errors";
import type { AnalysisResult } from "./types";

const GeminiResponse = z.object({
  candidates: z.array(
    z.object({
      content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }),
      finishReason: z.string().optional(),
    }),
  ).optional(),
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  usageMetadata: z.object({
    promptTokenCount: z.number().optional(),
    candidatesTokenCount: z.number().optional(),
  }).optional(),
});

const GeminiErrorResponse = z.object({ error: z.object({ message: z.string().optional() }).optional() });

export async function analyzeWithGemini(
  input: ReviewInput,
  frames: { mediaType: "image/jpeg"; data: string }[],
): Promise<AnalysisResult> {
  const apiKey = env.geminiApiKey;
  if (!apiKey) throw new AiError("GEMINI_API_KEY is not configured");
  const model = env.geminiModel;
  const parts = [
    ...frames.map((frame) => ({ inlineData: { mimeType: frame.mediaType, data: frame.data } })),
    { text: buildUserPrompt(input) },
  ];

  let response: Response;
  try {
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      signal: AbortSignal.timeout(5 * 60 * 1000),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts }],
        generationConfig: {
          maxOutputTokens: 16000,
          responseMimeType: "application/json",
          responseJsonSchema: z.toJSONSchema(WireProposal, { target: "draft-7" }),
        },
      }),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new AiError("Gemini request timed out.", true);
    }
    if (err instanceof TypeError) throw new AiError("Could not reach the Gemini API.", true);
    throw err;
  }

  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    const message = GeminiErrorResponse.safeParse(errorBody).data?.error?.message;
    if (response.status === 401 || response.status === 403) throw new AiError("Gemini API key was rejected or lacks permission. Check GEMINI_API_KEY.");
    if (response.status === 404) throw new AiError(`Gemini model "${model}" was not found. Check GEMINI_MODEL.`);
    if (response.status === 429) throw new AiError("Gemini API rate limit reached. Try again shortly.", true);
    if (response.status >= 500) throw new AiError(`Gemini API error (${response.status}).`, true);
    throw new AiError(`Gemini rejected the request: ${(message ?? `HTTP ${response.status}`).slice(0, 300)}`);
  }

  const body: unknown = await response.json().catch(() => null);
  const parsedResponse = GeminiResponse.safeParse(body);
  if (!parsedResponse.success) throw new AiError("Gemini returned an invalid response.", true);
  const candidate = parsedResponse.data.candidates?.[0];
  if (!candidate) {
    const reason = parsedResponse.data.promptFeedback?.blockReason;
    throw new AiError(reason ? `Gemini blocked the request (${reason}).` : "Gemini returned no candidate.", true);
  }
  if (candidate.finishReason === "MAX_TOKENS") {
    throw new AiError("Gemini's response was cut off before completing. Try again with fewer comments.", true);
  }
  if (candidate.finishReason && candidate.finishReason !== "STOP") {
    throw new AiError(`Gemini could not complete the analysis (${candidate.finishReason}).`);
  }
  const text = candidate.content.parts.map((part) => part.text ?? "").join("").trim();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AiError("Gemini returned invalid JSON instead of a structured proposal.", true);
  }
  const proposal = WireProposal.safeParse(json);
  if (!proposal.success) {
    throw new AiError(`Gemini's output failed schema validation: ${proposal.error.issues[0]?.message ?? "invalid proposal"}`, true);
  }

  const usage = {
    input_tokens: parsedResponse.data.usageMetadata?.promptTokenCount ?? 0,
    output_tokens: parsedResponse.data.usageMetadata?.candidatesTokenCount ?? 0,
  };
  log.info("ai.analysis_complete", {
    provider: "gemini",
    model,
    operations: proposal.data.operations.length,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
  });
  // The dynamic Zod union validates at runtime but widens operation fields to a generic record.
  return { proposal: proposal.data as unknown as WireProposalT, model, usage, stop_reason: candidate.finishReason ?? null };
}
