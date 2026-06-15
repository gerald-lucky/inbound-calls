-- ═══════════════════════════════════════════════════════════════════════════
-- Lucky Communities — AI Call Agent · Consolidated Schema
-- Idempotent: safe to re-run (CREATE IF NOT EXISTS, CREATE OR REPLACE, etc.)
-- Embedding model: Supabase gte-small via Edge Function (384 dimensions)
-- Run once on a fresh database — migrations 002/003/004 are stubs.
-- ═══════════════════════════════════════════════════════════════════════════


-- ── Extensions ───────────────────────────────────────────────────────────────

create extension if not exists vector;


-- ── Shared trigger function ───────────────────────────────────────────────────

create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;


-- ── Agent Configurations ──────────────────────────────────────────────────────
-- One row per Twilio number. Controls which AI agent persona answers each call.

create table if not exists agent_configs (
  id             uuid        primary key default gen_random_uuid(),
  name           text        not null,
  twilio_number  text        not null unique,
  quo_number     text,
  system_prompt  text        not null,
  voice_id       text        not null default '21m00Tcm4TlvDq8ikWAM',
  greeting       text        not null default 'Hello! Thanks for calling. How can I help you today?',
  is_active      boolean     not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create or replace trigger agent_configs_updated_at
  before update on agent_configs
  for each row execute function touch_updated_at();


-- ── Knowledge Base Documents ──────────────────────────────────────────────────
-- Stores uploaded files (PDFs, text). Scoped per agent config.

create table if not exists documents (
  id              uuid        primary key default gen_random_uuid(),
  filename        text        not null,
  agent_config_id uuid        references agent_configs(id) on delete cascade,
  file_path       text,                        -- path inside Supabase Storage bucket
  file_type       text,                        -- MIME type (application/pdf, text/plain)
  file_size       bigint,                      -- bytes
  content         text,                        -- cached extracted text (optional)
  status          text        not null default 'processing'
                              check (status in ('processing', 'ready', 'error')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists documents_agent_config_idx on documents (agent_config_id);
create index if not exists documents_status_idx       on documents (status);

create or replace trigger documents_updated_at
  before update on documents
  for each row execute function touch_updated_at();


-- ── Document Chunks ───────────────────────────────────────────────────────────
-- Chunked text with 384-dim embeddings from Supabase gte-small model.

create table if not exists document_chunks (
  id            uuid        primary key default gen_random_uuid(),
  document_id   uuid        not null references documents(id) on delete cascade,
  content       text        not null,
  embedding     vector(384),                   -- gte-small output (384 dims)
  chunk_index   integer     not null,
  created_at    timestamptz not null default now()
);

-- HNSW index: no training needed, works on empty tables, best for < 1M rows
create index if not exists document_chunks_embedding_idx
  on document_chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Composite index for bulk deletions by document
create index if not exists document_chunks_doc_idx on document_chunks (document_id);


-- ── Calls ─────────────────────────────────────────────────────────────────────

create table if not exists calls (
  id               uuid        primary key default gen_random_uuid(),
  call_sid         text        not null unique,
  agent_config_id  uuid        references agent_configs(id) on delete set null,
  twilio_number    text,
  caller_number    text        not null,
  started_at       timestamptz not null default now(),
  ended_at         timestamptz,
  duration_seconds integer,
  transcript       jsonb       not null default '[]'::jsonb,
  created_at       timestamptz not null default now()
);

create index if not exists calls_agent_config_idx on calls (agent_config_id);
create index if not exists calls_caller_idx       on calls (caller_number);
create index if not exists calls_started_at_idx   on calls (started_at desc);


-- ── Leads ─────────────────────────────────────────────────────────────────────

create table if not exists leads (
  id              uuid        primary key default gen_random_uuid(),
  call_id         uuid        references calls(id) on delete set null,
  agent_config_id uuid        references agent_configs(id) on delete set null,
  caller_number   text        not null,
  name            text,
  email           text,
  notes           text,
  created_at      timestamptz not null default now()
);

create index if not exists leads_agent_config_idx on leads (agent_config_id);
create index if not exists leads_created_at_idx   on leads (created_at desc);


-- ── Tenants ───────────────────────────────────────────────────────────────────

create table if not exists tenants (
  id               uuid          primary key default gen_random_uuid(),
  first_name       text          not null,
  last_name        text          not null,
  phone_number     text          not null unique,
  email            text,
  lot_number       text          not null unique,
  lot_rent_amount  numeric(10,2) not null,
  move_in_date     date          not null,
  balance_due      numeric(10,2) not null default 0,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

create index if not exists tenants_phone_idx on tenants (phone_number);

create or replace trigger tenants_updated_at
  before update on tenants
  for each row execute function touch_updated_at();


-- ── Payments ──────────────────────────────────────────────────────────────────

create table if not exists payments (
  id            uuid          primary key default gen_random_uuid(),
  tenant_id     uuid          not null references tenants(id) on delete cascade,
  amount        numeric(10,2) not null,
  payment_date  date          not null,
  month_year    text          not null,   -- YYYY-MM
  status        text          not null default 'paid'
                              check (status in ('paid', 'partial', 'waived')),
  notes         text,
  created_at    timestamptz   not null default now()
);

create index if not exists payments_tenant_idx on payments (tenant_id);
create index if not exists payments_month_idx  on payments (month_year);


-- ── Views ─────────────────────────────────────────────────────────────────────

create or replace view documents_with_chunk_count as
  select
    d.id,
    d.filename,
    d.agent_config_id,
    d.file_path,
    d.file_type,
    d.file_size,
    d.status,
    d.created_at,
    count(dc.id)::int as chunk_count
  from documents d
  left join document_chunks dc on dc.document_id = d.id
  group by d.id, d.filename, d.agent_config_id, d.file_path,
           d.file_type, d.file_size, d.status, d.created_at
  order by d.created_at desc;

create or replace view call_stats as
  select
    count(*)::int                                                          as total_calls,
    count(*) filter (where ended_at is not null)::int                     as completed_calls,
    round(avg(duration_seconds) filter (where duration_seconds > 0))::int as avg_duration_seconds,
    count(distinct caller_number)::int                                     as unique_callers,
    count(*) filter (where started_at >= now() - interval '7 days')::int  as calls_last_7_days,
    count(*) filter (where started_at >= now() - interval '30 days')::int as calls_last_30_days
  from calls;

-- Includes full config columns so the routing page needs only one query
create or replace view agent_config_stats as
  select
    ac.id,
    ac.name,
    ac.twilio_number,
    ac.quo_number,
    ac.system_prompt,
    ac.voice_id,
    ac.greeting,
    ac.is_active,
    ac.created_at,
    ac.updated_at,
    count(c.id)::int                                                                    as total_calls,
    count(c.id) filter (where c.started_at >= now() - interval '7 days')::int         as calls_last_7_days,
    round(avg(c.duration_seconds) filter (where c.duration_seconds > 0))::int          as avg_duration_seconds
  from agent_configs ac
  left join calls c on c.agent_config_id = ac.id
  group by ac.id, ac.name, ac.twilio_number, ac.quo_number, ac.system_prompt,
           ac.voice_id, ac.greeting, ac.is_active, ac.created_at, ac.updated_at
  order by ac.created_at desc;

create or replace view payments_with_tenant as
  select
    p.id,
    p.tenant_id,
    p.amount,
    p.payment_date,
    p.month_year,
    p.status,
    p.notes,
    p.created_at,
    t.first_name,
    t.last_name,
    t.lot_number
  from payments p
  join tenants t on t.id = p.tenant_id
  order by p.payment_date desc;


-- ── Functions ─────────────────────────────────────────────────────────────────

create or replace function append_transcript(p_call_id uuid, p_entry jsonb)
returns void language sql as $$
  update calls
  set transcript = transcript || jsonb_build_array(p_entry)
  where id = p_call_id;
$$;

-- Semantic similarity search across knowledge base chunks.
-- Uses gte-small embeddings (384 dims). Threshold 0.5 suits gte-small score range.
create or replace function match_chunks(
  query_embedding        vector(384),
  match_count            int   default 5,
  match_threshold        float default 0.5,
  filter_agent_config_id uuid  default null
)
returns table (
  id          uuid,
  content     text,
  document_id uuid,
  similarity  float
)
language sql stable as $$
  select
    dc.id,
    dc.content,
    dc.document_id,
    1 - (dc.embedding <=> query_embedding) as similarity
  from document_chunks dc
  join documents d on d.id = dc.document_id
  where d.status = 'ready'
    and 1 - (dc.embedding <=> query_embedding) > match_threshold
    and (filter_agent_config_id is null or d.agent_config_id = filter_agent_config_id)
  order by dc.embedding <=> query_embedding
  limit match_count;
$$;


-- ── Supabase Storage ──────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('knowledge-base', 'knowledge-base', false)
on conflict (id) do nothing;

-- Idempotent policy creation
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename  = 'objects'
      and policyname = 'Service role can manage knowledge-base files'
  ) then
    create policy "Service role can manage knowledge-base files"
      on storage.objects for all to service_role
      using (bucket_id = 'knowledge-base');
  end if;
end
$$;
