-- ─── Agent Configurations ─────────────────────────────────────────────────
-- One row per Twilio number. Controls which agent persona answers each number.

create table agent_configs (
  id uuid primary key default gen_random_uuid(),
  name text not null,                                   -- display name, e.g. "Sales Line"
  twilio_number text not null unique,                   -- e.g. +15551234567 (must match Twilio)
  quo_number text,                                      -- the Quo/OpenPhone number forwarding here
  system_prompt text not null,
  voice_id text not null default '21m00Tcm4TlvDq8ikWAM',
  greeting text not null default 'Hello! Thanks for calling. How can I help you today?',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-update updated_at on any row change
create or replace function touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agent_configs_updated_at
  before update on agent_configs
  for each row execute function touch_updated_at();


-- ─── Call Logs ────────────────────────────────────────────────────────────────

create table calls (
  id uuid primary key default gen_random_uuid(),
  call_sid text unique not null,                        -- Twilio CallSid
  agent_config_id uuid references agent_configs(id) on delete set null,
  twilio_number text,
  caller_number text not null,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer,
  -- Transcript stored as array of {role, text, ts}
  transcript jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index on calls (agent_config_id);
create index on calls (caller_number);
create index on calls (started_at desc);


-- ─── Leads ────────────────────────────────────────────────────────────────────

create table leads (
  id uuid primary key default gen_random_uuid(),
  call_id uuid references calls(id) on delete set null,
  agent_config_id uuid references agent_configs(id) on delete set null,
  caller_number text not null,
  name text,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

create index on leads (agent_config_id);
create index on leads (created_at desc);


-- ─── Dashboard Stats View ─────────────────────────────────────────────────────

create view call_stats as
select
  count(*)::int                                                        as total_calls,
  count(*) filter (where ended_at is not null)::int                   as completed_calls,
  round(avg(duration_seconds) filter (where duration_seconds > 0))::int as avg_duration_seconds,
  count(distinct caller_number)::int                                   as unique_callers,
  count(*) filter (where started_at >= now() - interval '7 days')::int as calls_last_7_days,
  count(*) filter (where started_at >= now() - interval '30 days')::int as calls_last_30_days
from calls;


-- ─── Helper: append a JSON object to calls.transcript array ─────────────────

create or replace function append_transcript(p_call_id uuid, p_entry jsonb)
returns void language sql as $$
  update calls
  set transcript = transcript || jsonb_build_array(p_entry)
  where id = p_call_id;
$$;


-- ─── Calls-per-config summary for the routing page ───────────────────────────

create view agent_config_stats as
select
  ac.id,
  ac.name,
  ac.twilio_number,
  ac.quo_number,
  ac.is_active,
  count(c.id)::int                                               as total_calls,
  count(c.id) filter (where c.started_at >= now() - interval '7 days')::int as calls_last_7_days,
  round(avg(c.duration_seconds) filter (where c.duration_seconds > 0))::int  as avg_duration_seconds
from agent_configs ac
left join calls c on c.agent_config_id = ac.id
group by ac.id, ac.name, ac.twilio_number, ac.quo_number, ac.is_active
order by ac.created_at desc;
