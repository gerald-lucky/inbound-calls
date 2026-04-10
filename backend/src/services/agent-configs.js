'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Find the active agent config for a given Twilio number.
 * Returns null if no config is found (call will use env-var defaults).
 * @param {string} twilioNumber - e.g. "+15551234567"
 * @returns {Promise<object|null>}
 */
async function findByTwilioNumber(twilioNumber) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('twilio_number', twilioNumber)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    console.error('[agent-configs] Lookup error:', error.message);
    return null;
  }
  return data;
}

/**
 * List all agent configs with per-config call stats.
 * @returns {Promise<Array>}
 */
async function list() {
  const { data, error } = await supabase
    .from('agent_config_stats')
    .select('*');
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Get a single agent config by ID.
 * @param {string} id
 */
async function getById(id) {
  const { data, error } = await supabase
    .from('agent_configs')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Create a new agent config.
 * @param {object} fields
 */
async function create(fields) {
  const { data, error } = await supabase
    .from('agent_configs')
    .insert(fields)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Update an agent config.
 * @param {string} id
 * @param {object} fields
 */
async function update(id, fields) {
  const { data, error } = await supabase
    .from('agent_configs')
    .update(fields)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Delete an agent config.
 * @param {string} id
 */
async function remove(id) {
  const { error } = await supabase
    .from('agent_configs')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = { findByTwilioNumber, list, getById, create, update, remove };
