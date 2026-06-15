-- Add speaks_first to agent_configs.
-- true (default): bot immediately says the greeting when connected — correct for outbound.
-- false: bot waits silently for the caller to speak first.
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS speaks_first boolean NOT NULL DEFAULT true;
