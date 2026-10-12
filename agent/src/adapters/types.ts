import type { AdapterId, AgentJobOperation, AgentJobPayload, OpType } from "../../../src/shared/operations";

export interface AdapterCapabilities {
  id: AdapterId;
  label: string;
  /** false = scaffold only. The agent never advertises unimplemented adapters for jobs. */
  implemented: boolean;
  automated: boolean;
  supportedOps: OpType[];
  details: Record<string, unknown>;
}

export interface ProjectInspection {
  sourcePath: string | null;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  hasAudio: boolean | null;
  notes: string[];
}

export interface JobContext {
  payload: AgentJobPayload;
  workDir: string;
  signal: AbortSignal;
  log(level: "debug" | "info" | "warn" | "error", message: string, data?: unknown): Promise<void>;
  progress(fraction: number, message: string): void;
  reportOperation(opId: string, status: string, note?: string | null): Promise<void>;
  /** Server-side view of the job (used by the manual adapter to read checklist ticks). */
  fetchState(): Promise<{ status: string; operations: { id: string; execution_status: string }[] }>;
}

export interface OperationOutcome {
  /** Reported execution status. Never "done" until the edit is really applied. */
  status: "pending" | "running" | "manual_pending" | "done" | "skipped";
  note?: string;
}

export interface ExecutionResult {
  render: { path: string; contentType: string; filename: string } | null;
  summary: string;
}

export class NonRetryableError extends Error {}
export class JobCancelledError extends Error {}
/** The job was completed or stopped by someone else (e.g. the editor in the web app). */
export class JobNoLongerRunningError extends Error {}

/**
 * Common editor adapter interface. Adapters execute only operations from the
 * closed catalog; they never execute commands supplied by the server or AI.
 */
export interface EditorAdapter {
  readonly id: AdapterId;
  /** whether the runner should download the source video before inspection */
  readonly needsSource: boolean;
  getCapabilities(): Promise<AdapterCapabilities>;
  inspectProject(ctx: JobContext): Promise<ProjectInspection>;
  validateOperation(op: AgentJobOperation, inspection: ProjectInspection): { ok: boolean; errors: string[] };
  executeApprovedOperation(op: AgentJobOperation, ctx: JobContext, inspection: ProjectInspection): Promise<OperationOutcome>;
  /** Produces the job's output (render) after all operations were executed/planned. */
  finalizeJob(ctx: JobContext, inspection: ProjectInspection): Promise<ExecutionResult>;
  getJobStatus(jobId: string): { state: "idle" | "running" | "waiting_for_human" | "rendering"; detail?: string };
  cancelJob(jobId: string): Promise<void>;
}
