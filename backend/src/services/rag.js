'use strict';

const { createClient } = require('@supabase/supabase-js');
const { embed }        = require('./embedding');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const DEFAULT_COUNT     = 5;
const DEFAULT_THRESHOLD = 0.5;

async function searchChunks(query, agentConfigId, matchCount = DEFAULT_COUNT) {
  try {
    const embedding = await embed(query);

    const { data, error } = await supabase.rpc('match_chunks', {
      query_embedding:        embedding,
      match_count:            matchCount,
      match_threshold:        DEFAULT_THRESHOLD,
      filter_agent_config_id: agentConfigId || null,
    });

    if (error) {
      console.error('[rag] match_chunks error:', error.message);
      return [];
    }

    return (data || []).map((row) => ({
      content:    row.content,
      similarity: row.similarity,
    }));
  } catch (err) {
    console.error('[rag] searchChunks error:', err.message);
    return [];
  }
}

async function buildContext(query, agentConfigId, matchCount = DEFAULT_COUNT) {
  const chunks = await searchChunks(query, agentConfigId, matchCount);
  if (!chunks.length) return '';

  const lines = chunks.map((c) => `- ${c.content.trim()}`).join('\n');
  return `Relevant knowledge base context:\n${lines}`;
}

module.exports = { searchChunks, buildContext };
