import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeWithGemini } from "@/lib/ai/gemini";
import type { ReviewInput } from "@/lib/ai/prompt";

const input: ReviewInput = {
  project: { name: "Project", description: null },
  video: { title: "Video" },
  source_version: {
    id: "00000000-0000-4000-8000-000000000001",
    version_number: 1,
    duration_ms: 10000,
    width: 1920,
    height: 1080,
    frame_rate: 30,
    has_audio: true,
  },
  adapter: "manual",
  comments: [],
  frames_attached: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Gemini analyzer", () => {
  it("requests schema-constrained JSON and validates the proposal", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODEL", "gemini-test-model");
    const proposal = { summary: "No edits requested.", operations: [], comment_coverage: [] };
    const fetchMock = vi.fn(async (url: string | URL | Request, request?: RequestInit) => {
      expect(String(url)).toContain("/models/gemini-test-model:generateContent");
      expect(request?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
      const body = JSON.parse(String(request?.body));
      expect(body.generationConfig.responseMimeType).toBe("application/json");
      expect(body.generationConfig.responseJsonSchema).toBeDefined();
      expect(body.contents[0].parts[0].inlineData.mimeType).toBe("image/jpeg");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(proposal) }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await analyzeWithGemini(input, [{ mediaType: "image/jpeg", data: "ZmFrZQ==" }]);

    expect(result).toMatchObject({
      proposal,
      model: "gemini-test-model",
      usage: { input_tokens: 12, output_tokens: 7 },
      stop_reason: "STOP",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects output that does not match the proposal schema", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"unexpected":true}' }] }, finishReason: "STOP" }] }),
          { status: 200 },
        ),
      ),
    );

    await expect(analyzeWithGemini(input, [])).rejects.toThrow(/schema validation/i);
  });
});
