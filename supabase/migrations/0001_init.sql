-- ReelReview initial schema.
-- Runs unchanged on Supabase PostgreSQL and on PGlite (local development mode).
-- All access goes through the server using the database owner role; row level
-- security is enabled with no policies so Supabase's anon/authenticated roles
-- (PostgREST) can read or write nothing.

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 200),
  description text check (description is null or char_length(description) <= 2000),
  status text not null default 'active' check (status in ('active', 'archived')),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_workspace_status_idx on projects (workspace_id, status, updated_at desc);

create table videos (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 300),
  status text not null default 'active' check (status in ('active', 'archived')),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index videos_project_idx on videos (project_id, status, created_at desc);

create table video_versions (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete restrict,
  version_number integer not null check (version_number >= 1),
  status text not null default 'uploading'
    check (status in ('uploading', 'processing', 'ready', 'failed')),
  source text not null default 'upload'
    check (source in ('upload', 'agent_render', 'manual_revision')),
  storage_key text not null unique,
  original_filename text not null check (char_length(original_filename) <= 500),
  content_type text not null,
  size_bytes bigint not null check (size_bytes > 0),
  -- multipart upload bookkeeping (cleared once the object is complete)
  upload_id text,
  part_size_bytes integer,
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  frame_rate double precision check (frame_rate is null or frame_rate > 0),
  video_codec text,
  audio_codec text,
  has_audio boolean,
  -- false when the uploading browser could not decode the file (unsupported codec)
  browser_playable boolean,
  thumbnail_key text,
  processing_error text,
  probe_source text check (probe_source is null or probe_source in ('browser', 'ffprobe')),
  produced_by_job_id uuid,
  produced_by_proposal_id uuid,
  notes text check (notes is null or char_length(notes) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_id, version_number)
);
create index video_versions_video_idx on video_versions (video_id, version_number desc);

alter table videos
  add constraint videos_current_version_fk
  foreign key (current_version_id) references video_versions(id) on delete set null;

create table review_links (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete restrict,
  video_id uuid references videos(id) on delete restrict,
  scope text not null check (scope in ('project', 'video')),
  -- sha256 of the raw token; lookups only ever use the hash
  token_hash text not null unique,
  -- AES-256-GCM ciphertext of the token so the editor can copy the link again.
  -- Decryptable only with APP_SECRET, which never reaches the database.
  token_ciphertext text not null,
  label text check (label is null or char_length(label) <= 200),
  can_comment boolean not null default true,
  expires_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  check ((scope = 'video') = (video_id is not null))
);
create index review_links_project_idx on review_links (project_id, created_at desc);

-- A guest identity is a display name plus a random browser key, scoped to one
-- review link. It identifies a commenter; it is NOT authentication.
create table guest_identities (
  id uuid primary key default gen_random_uuid(),
  review_link_id uuid not null references review_links(id) on delete restrict,
  client_key_hash text not null,
  display_name text not null check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (review_link_id, client_key_hash)
);

create table comments (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete restrict,
  video_version_id uuid not null references video_versions(id) on delete restrict,
  parent_id uuid references comments(id) on delete restrict,
  author_type text not null check (author_type in ('client', 'editor', 'ai', 'system')),
  -- snapshot of the name at the time of writing; renaming later never rewrites it
  author_name text not null check (char_length(author_name) between 1 and 80),
  guest_identity_id uuid references guest_identities(id) on delete set null,
  review_link_id uuid references review_links(id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  timestamp_ms integer check (timestamp_ms is null or timestamp_ms >= 0),
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (parent_id is not null or timestamp_ms is not null)
);
create index comments_version_idx on comments (video_version_id, timestamp_ms, created_at);
create index comments_parent_idx on comments (parent_id);

create table comment_attachments (
  id uuid primary key default gen_random_uuid(),
  comment_id uuid not null references comments(id) on delete cascade,
  kind text not null check (kind in ('annotation', 'screenshot', 'reference_image')),
  data jsonb,
  storage_key text,
  created_at timestamptz not null default now(),
  check (data is not null or storage_key is not null)
);
create index comment_attachments_comment_idx on comment_attachments (comment_id);

create table edit_proposals (
  id uuid primary key default gen_random_uuid(),
  video_id uuid not null references videos(id) on delete restrict,
  source_version_id uuid not null references video_versions(id) on delete restrict,
  -- all revisions of one proposal share root_id; revision increments
  root_id uuid,
  revision integer not null default 1 check (revision >= 1),
  supersedes_id uuid references edit_proposals(id) on delete restrict,
  status text not null default 'draft' check (status in (
    'draft', 'validated', 'awaiting_approval', 'approved', 'queued', 'running',
    'completed', 'failed', 'rejected', 'cancelled', 'needs_clarification')),
  adapter text not null,
  generator text not null check (generator in ('claude', 'offline_rules')),
  model text,
  summary text,
  comment_coverage jsonb not null default '[]'::jsonb,
  input_snapshot jsonb,
  raw_response jsonb,
  content_hash text,
  approved_hash text,
  approved_at timestamptz,
  approved_by text,
  status_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status in ('approved', 'queued', 'running', 'completed')) <= (approved_hash is not null))
);
create index edit_proposals_video_idx on edit_proposals (video_id, created_at desc);
create unique index edit_proposals_root_revision_idx on edit_proposals (root_id, revision);

create table edit_operations (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references edit_proposals(id) on delete cascade,
  op_key text not null check (char_length(op_key) between 1 and 64),
  position integer not null,
  source_comment_ids jsonb not null default '[]'::jsonb,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer check (end_ms is null or end_ms >= start_ms),
  op_type text not null,
  params jsonb not null default '{}'::jsonb,
  explanation text not null,
  confidence double precision not null check (confidence between 0 and 1),
  uncertainty text,
  clarification_question text,
  needs_clarification boolean not null default false,
  validation_status text not null default 'valid'
    check (validation_status in ('valid', 'invalid', 'needs_clarification', 'unsupported')),
  validation_errors jsonb not null default '[]'::jsonb,
  adapter_compat jsonb not null default '{}'::jsonb,
  decision text not null default 'pending' check (decision in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  edited_by_editor boolean not null default false,
  execution_status text not null default 'not_started' check (execution_status in (
    'not_started', 'pending', 'running', 'done', 'failed', 'skipped', 'manual_pending', 'manual_done')),
  execution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (proposal_id, op_key)
);
create index edit_operations_proposal_idx on edit_operations (proposal_id, position);

create table agent_devices (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  registration_code_hash text unique,
  registration_expires_at timestamptz,
  token_hash text unique,
  platform text,
  agent_version text,
  adapters jsonb not null default '[]'::jsonb,
  capabilities jsonb not null default '{}'::jsonb,
  last_seen_at timestamptz,
  registered_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table edit_jobs (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references edit_proposals(id) on delete restrict,
  video_id uuid not null references videos(id) on delete restrict,
  source_version_id uuid not null references video_versions(id) on delete restrict,
  adapter text not null,
  -- the exact approved revision this job is allowed to execute
  approved_hash text not null,
  idempotency_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  target_device_id uuid references agent_devices(id) on delete set null,
  claimed_by_device_id uuid references agent_devices(id) on delete set null,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts >= 1),
  lease_expires_at timestamptz,
  progress double precision not null default 0 check (progress between 0 and 1),
  progress_message text,
  cancel_requested boolean not null default false,
  finish_without_render boolean not null default false,
  render_storage_key text,
  render_upload_id text,
  error text,
  result_version_id uuid references video_versions(id) on delete set null,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index edit_jobs_status_idx on edit_jobs (status, created_at);
-- at most one live job per proposal revision
create unique index edit_jobs_one_active_per_proposal on edit_jobs (proposal_id)
  where status in ('queued', 'running');

alter table video_versions
  add constraint video_versions_job_fk foreign key (produced_by_job_id) references edit_jobs(id) on delete set null,
  add constraint video_versions_proposal_fk foreign key (produced_by_proposal_id) references edit_proposals(id) on delete set null;

create table edit_job_logs (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references edit_jobs(id) on delete cascade,
  level text not null check (level in ('debug', 'info', 'warn', 'error')),
  source text not null check (source in ('server', 'agent', 'editor')),
  message text not null check (char_length(message) <= 4000),
  data jsonb,
  created_at timestamptz not null default now()
);
create index edit_job_logs_job_idx on edit_job_logs (job_id, created_at);

create table activity_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  video_id uuid references videos(id) on delete cascade,
  actor_type text not null check (actor_type in ('editor', 'client', 'ai', 'agent', 'system')),
  actor_name text,
  event_type text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index activity_events_created_idx on activity_events (created_at desc);
create index activity_events_project_idx on activity_events (project_id, created_at desc);
create index activity_events_video_idx on activity_events (video_id, created_at desc);

-- Fixed-window rate limiting shared across server instances.
create table rate_limits (
  key text primary key,
  window_start timestamptz not null,
  count integer not null
);

-- ---------------------------------------------------------------------------
-- Integrity guards
-- ---------------------------------------------------------------------------

create or replace function set_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger workspaces_updated before update on workspaces for each row execute function set_updated_at();
create trigger projects_updated before update on projects for each row execute function set_updated_at();
create trigger videos_updated before update on videos for each row execute function set_updated_at();
create trigger video_versions_updated before update on video_versions for each row execute function set_updated_at();
create trigger comments_updated before update on comments for each row execute function set_updated_at();
create trigger edit_proposals_updated before update on edit_proposals for each row execute function set_updated_at();
create trigger edit_operations_updated before update on edit_operations for each row execute function set_updated_at();
create trigger edit_jobs_updated before update on edit_jobs for each row execute function set_updated_at();
create trigger agent_devices_updated before update on agent_devices for each row execute function set_updated_at();

-- Once a proposal revision is approved its operations are frozen. Only
-- execution bookkeeping may change; anything material requires a new revision.
create or replace function guard_frozen_operations() returns trigger language plpgsql as $$
declare
  proposal_status text;
begin
  select status into proposal_status from edit_proposals where id = old.proposal_id;
  if proposal_status in ('approved', 'queued', 'running', 'completed', 'failed') then
    if tg_op = 'DELETE' then
      raise exception 'edit operation % belongs to an approved proposal revision and cannot be deleted', old.id;
    end if;
    if new.op_type is distinct from old.op_type
       or new.params is distinct from old.params
       or new.start_ms is distinct from old.start_ms
       or new.end_ms is distinct from old.end_ms
       or new.decision is distinct from old.decision
       or new.source_comment_ids is distinct from old.source_comment_ids
       or new.proposal_id is distinct from old.proposal_id then
      raise exception 'edit operation % belongs to an approved proposal revision; create a new revision instead', old.id;
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end $$;

create trigger edit_operations_frozen before update or delete on edit_operations
  for each row execute function guard_frozen_operations();

create or replace function guard_frozen_proposal() returns trigger language plpgsql as $$
begin
  if old.approved_hash is not null and old.status in ('approved', 'queued', 'running', 'completed', 'failed') then
    if new.approved_hash is distinct from old.approved_hash
       or new.content_hash is distinct from old.content_hash
       or new.source_version_id is distinct from old.source_version_id
       or new.adapter is distinct from old.adapter then
      raise exception 'proposal % is approved; its content, source version and adapter are immutable', old.id;
    end if;
  end if;
  return new;
end $$;

create trigger edit_proposals_frozen before update on edit_proposals
  for each row execute function guard_frozen_proposal();

-- Jobs can only be created for an approved revision whose hash matches.
create or replace function guard_job_insert() returns trigger language plpgsql as $$
declare
  p record;
begin
  select status, approved_hash, source_version_id, adapter into p from edit_proposals where id = new.proposal_id;
  if p.approved_hash is null or p.approved_hash <> new.approved_hash then
    raise exception 'cannot create a job for proposal % without a matching approval', new.proposal_id;
  end if;
  if p.source_version_id <> new.source_version_id or p.adapter <> new.adapter then
    raise exception 'job source version/adapter does not match the approved proposal %', new.proposal_id;
  end if;
  return new;
end $$;

create trigger edit_jobs_insert_guard before insert on edit_jobs
  for each row execute function guard_job_insert();

-- ---------------------------------------------------------------------------
-- Row level security: deny-by-default for Supabase client roles.
-- ---------------------------------------------------------------------------
alter table workspaces enable row level security;
alter table projects enable row level security;
alter table videos enable row level security;
alter table video_versions enable row level security;
alter table review_links enable row level security;
alter table guest_identities enable row level security;
alter table comments enable row level security;
alter table comment_attachments enable row level security;
alter table edit_proposals enable row level security;
alter table edit_operations enable row level security;
alter table edit_jobs enable row level security;
alter table edit_job_logs enable row level security;
alter table agent_devices enable row level security;
alter table activity_events enable row level security;
alter table rate_limits enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
  end if;
end $$;

insert into workspaces (id, name) values ('00000000-0000-4000-8000-000000000001', 'Default workspace');
