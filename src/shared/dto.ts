/** Serializable shapes shared between API routes and client components. */

export type ProjectStatus = "active" | "archived";
export type VersionStatus = "uploading" | "processing" | "ready" | "failed";
export type AuthorType = "client" | "editor" | "ai" | "system";

export interface ProjectDTO {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  created_at: string;
  updated_at: string;
  video_count: number;
  open_comment_count: number;
  thumbnail_url: string | null;
}

export interface VideoVersionDTO {
  id: string;
  video_id: string;
  version_number: number;
  status: VersionStatus;
  source: "upload" | "agent_render" | "manual_revision";
  original_filename: string;
  content_type: string;
  size_bytes: number;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  frame_rate: number | null;
  video_codec: string | null;
  has_audio: boolean | null;
  browser_playable: boolean | null;
  processing_error: string | null;
  produced_by_job_id: string | null;
  produced_by_proposal_id: string | null;
  notes: string | null;
  created_at: string;
  comment_count?: number;
  playback_url?: string | null;
  thumbnail_url?: string | null;
}

export interface VideoDTO {
  id: string;
  project_id: string;
  title: string;
  status: ProjectStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
  version_count: number;
  open_comment_count: number;
  current_version: VideoVersionDTO | null;
}

export interface AnnotationStroke {
  color: string;
  width: number; // relative to frame width (0..1)
  points: [number, number][]; // normalized 0..1
}

export interface AttachmentDTO {
  id: string;
  kind: "annotation" | "screenshot" | "reference_image";
  data: { strokes?: AnnotationStroke[] } | null;
}

export interface CommentDTO {
  id: string;
  video_id: string;
  video_version_id: string;
  parent_id: string | null;
  author_type: AuthorType;
  author_name: string;
  body: string;
  timestamp_ms: number | null;
  status: "open" | "resolved";
  resolved_at: string | null;
  resolved_by_name: string | null;
  created_at: string;
  is_mine?: boolean;
  attachments: AttachmentDTO[];
  replies: CommentDTO[];
}

export interface ReviewLinkDTO {
  id: string;
  project_id: string;
  video_id: string | null;
  video_title: string | null;
  scope: "project" | "video";
  label: string | null;
  can_comment: boolean;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
  url: string | null;
  state: "active" | "revoked" | "expired";
}

export interface ActivityDTO {
  id: string;
  project_id: string | null;
  video_id: string | null;
  actor_type: "editor" | "client" | "ai" | "agent" | "system";
  actor_name: string | null;
  event_type: string;
  data: Record<string, unknown>;
  created_at: string;
  project_name?: string | null;
  video_title?: string | null;
}

export type ProposalStatus =
  | "draft"
  | "validated"
  | "awaiting_approval"
  | "approved"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "cancelled"
  | "needs_clarification";

export interface OperationDTO {
  id: string;
  proposal_id: string;
  op_key: string;
  position: number;
  source_comment_ids: string[];
  start_ms: number;
  end_ms: number | null;
  op_type: string;
  params: Record<string, unknown>;
  explanation: string;
  confidence: number;
  uncertainty: string | null;
  clarification_question: string | null;
  needs_clarification: boolean;
  validation_status: "valid" | "invalid" | "needs_clarification" | "unsupported";
  validation_errors: string[];
  adapter_compat: Record<string, boolean>;
  decision: "pending" | "approved" | "rejected";
  decided_at: string | null;
  edited_by_editor: boolean;
  execution_status: string;
  execution_note: string | null;
}

export interface CommentCoverage {
  comment_id: string;
  status: "addressed" | "needs_clarification" | "not_actionable";
  note: string;
}

export interface ProposalDTO {
  id: string;
  video_id: string;
  video_title?: string;
  project_id?: string;
  project_name?: string;
  source_version_id: string;
  source_version_number?: number;
  root_id: string | null;
  revision: number;
  supersedes_id: string | null;
  status: ProposalStatus;
  adapter: string;
  generator: "claude" | "gemini" | "offline_rules";
  model: string | null;
  summary: string | null;
  comment_coverage: CommentCoverage[];
  content_hash: string | null;
  approved_hash: string | null;
  approved_at: string | null;
  approved_by: string | null;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  operations?: OperationDTO[];
  op_counts?: { total: number; approved: number; rejected: number; pending: number };
}

export interface JobDTO {
  id: string;
  proposal_id: string;
  video_id: string;
  video_title?: string;
  project_name?: string;
  proposal_revision?: number;
  source_version_id: string;
  adapter: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  target_device_id: string | null;
  target_device_name?: string | null;
  claimed_by_device_id: string | null;
  claimed_by_device_name?: string | null;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
  progress: number;
  progress_message: string | null;
  cancel_requested: boolean;
  finish_without_render: boolean;
  error: string | null;
  result_version_id: string | null;
  result_version_number?: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobLogDTO {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  source: "server" | "agent" | "editor";
  message: string;
  data: unknown;
  created_at: string;
}

export interface DeviceDTO {
  id: string;
  name: string;
  status: "pending" | "active" | "revoked";
  platform: string | null;
  agent_version: string | null;
  adapters: string[];
  capabilities: Record<string, unknown>;
  last_seen_at: string | null;
  registered_at: string | null;
  revoked_at: string | null;
  registration_expires_at: string | null;
  created_at: string;
  online: boolean;
}
