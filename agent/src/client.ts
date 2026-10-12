import type { AgentJobPayload } from "../../src/shared/operations";

export class AgentApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
  get retryable() {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Outbound-only, authenticated client for the ReelReview server. The agent
 * never opens a listening port; all communication is initiated here.
 */
export class AgentClient {
  constructor(
    private server: string,
    private token: string | null,
  ) {}

  async request<T>(path: string, body?: unknown, opts: { method?: string; retries?: number } = {}): Promise<T> {
    const retries = opts.retries ?? 4;
    let lastErr: AgentApiError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.server}${path}`, {
          method: opts.method ?? (body === undefined ? "GET" : "POST"),
          headers: {
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastErr = new AgentApiError(0, `Cannot reach server: ${(err as Error).message}`);
        if (attempt < retries) {
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
          continue;
        }
        throw lastErr;
      }
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (res.ok) return data as T;
      const message = (data as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
      lastErr = new AgentApiError(res.status, message);
      if (lastErr.retryable && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      throw lastErr;
    }
    throw lastErr ?? new AgentApiError(0, "Request failed");
  }

  register(body: { code: string; platform: string; agentVersion: string; adapters: string[]; capabilities: Record<string, unknown> }) {
    return this.request<{ deviceId: string; name: string; token: string }>("/api/agent/register", body, { retries: 1 });
  }
  heartbeatDevice(body: { agentVersion: string; adapters: string[]; capabilities: Record<string, unknown> }) {
    return this.request<{ ok: true; deviceId: string; name: string }>("/api/agent/heartbeat", body, { retries: 1 });
  }
  claim() {
    return this.request<{ job: AgentJobPayload | null }>("/api/agent/jobs/claim", {}, { retries: 1 });
  }
  jobState(jobId: string) {
    return this.request<{
      status: string;
      attempt: number;
      cancel_requested: boolean;
      finish_without_render: boolean;
      operations: { id: string; op_key: string; execution_status: string }[];
    }>(`/api/agent/jobs/${jobId}`);
  }
  job<T = unknown>(jobId: string, body: Record<string, unknown>, retries = 4) {
    return this.request<T>(`/api/agent/jobs/${jobId}`, body, { retries });
  }
}
