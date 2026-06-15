-- Migration 005: Add speaks_first column to agent_configs
-- Controls whether the agent speaks first when a call connects (default: true).

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS speaks_first boolean NOT NULL DEFAULT true;
