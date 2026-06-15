'use strict';

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Insert a new call record when a call starts.
 * @returns {Promise<string>} The new call's UUID.
 */
async function startCall({ callSid, agentConfigId, twilioNumber, callerNumber, direction = 'inbound' }) {
  const { data, error } = await supabase
    .from('calls')
    .insert({
      call_sid:        callSid,
      agent_config_id: agentConfigId || null,
      twilio_number:   twilioNumber  || null,
      caller_number:   callerNumber,
      started_at:      new Date().toISOString(),
      direction,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[call-logger] Failed to start call log:', error.message);
    return null;
  }
  return data.id;
}

/**
 * Append a transcript entry (called after each utterance + response pair).
 * Stored as JSONB array of {role, text, ts}.
 * @param {string} callId
 * @param {{ role: 'caller'|'agent', text: string }} entry
 */
async function appendTranscript(callId, entry) {
  if (!callId) return;
  const row = { role: entry.role, text: entry.text, ts: new Date().toISOString() };

  // Supabase jsonb array append via RPC is simplest with a raw SQL approach
  const { error } = await supabase.rpc('append_transcript', {
    p_call_id: callId,
    p_entry: row,
  });

  if (error) {
    // If the RPC doesn't exist yet (first migration), fall back silently
    console.error('[call-logger] appendTranscript error:', error.message);
  }
}

/**
 * Mark the call as ended and compute duration.
 * @param {string} callId
 * @param {Date} startedAt - When the call began (to compute duration).
 */
async function endCall(callId, startedAt) {
  if (!callId) return;
  const endedAt = new Date();
  const durationSeconds = Math.round((endedAt - startedAt) / 1000);

  const { error } = await supabase
    .from('calls')
    .update({
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
    })
    .eq('id', callId);

  if (error) {
    console.error('[call-logger] Failed to end call log:', error.message);
  }
}

/**
 * Save a captured lead.
 */
async function saveLead({ callId, agentConfigId, callerNumber, name, email, notes }) {
  const { error } = await supabase.from('leads').insert({
    call_id: callId || null,
    agent_config_id: agentConfigId || null,
    caller_number: callerNumber,
    name: name || null,
    email: email || null,
    notes: notes || null,
  });

  if (error) {
    console.error('[call-logger] Failed to save lead:', error.message);
  }
}

/**
 * Save an AI-generated summary to a call record.
 * @param {string} callId - our DB UUID
 * @param {string} summary
 */
async function saveSummary(callId, summary) {
  const { error } = await supabase
    .from('calls')
    .update({ summary })
    .eq('id', callId);
  if (error) console.error('[call-logger] saveSummary error:', error.message);
}

/**
 * Save a Twilio recording URL to the call record identified by Twilio's CallSid.
 * @param {string} callSid   - Twilio CallSid (e.g. "CAxxxx")
 * @param {string} recordingUrl
 */
async function saveRecordingUrl(callSid, recordingUrl) {
  const { error } = await supabase
    .from('calls')
    .update({ recording_url: recordingUrl })
    .eq('call_sid', callSid);
  if (error) {
    console.error('[call-logger] saveRecordingUrl error:', error.message);
  }
}

/**
 * List calls with optional filters.
 */
async function listCalls({ agentConfigId, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('calls')
    .select(`
      id, call_sid, twilio_number, caller_number,
      started_at, ended_at, duration_seconds, transcript,
      direction, recording_url, summary,
      agent_configs (id, name)
    `)
    .order('started_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (agentConfigId) query = query.eq('agent_config_id', agentConfigId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Get a single call's full record (including transcript).
 */
async function getCall(id) {
  const { data, error } = await supabase
    .from('calls')
    .select(`
      *, agent_configs (id, name, twilio_number)
    `)
    .eq('id', id)
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Look up a call's DB id by Twilio CallSid.
 * Returns null if not found.
 */
async function findCallBySid(callSid) {
  if (!callSid) return null;
  const { data } = await supabase
    .from('calls')
    .select('id')
    .eq('call_sid', callSid)
    .maybeSingle();
  return data?.id || null;
}

/**
 * Mark a call as ended (by Twilio status callback).
 * Only updates if ended_at is not already set, so it won't clobber
 * a record already closed by CallSession._teardown().
 */
async function finalizeCall(callSid, { durationSeconds } = {}) {
  const { error } = await supabase
    .from('calls')
    .update({
      ended_at:         new Date().toISOString(),
      duration_seconds: durationSeconds || null,
    })
    .eq('call_sid', callSid)
    .is('ended_at', null);
  if (error) console.error('[call-logger] finalizeCall error:', error.message);
}

/**
 * Get dashboard stats.
 */
async function getStats() {
  const { data, error } = await supabase
    .from('call_stats')
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * List leads with optional filters.
 */
async function listLeads({ agentConfigId, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from('leads')
    .select(`
      id, caller_number, name, email, notes, created_at,
      calls (id, call_sid, started_at),
      agent_configs (id, name)
    `)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (agentConfigId) query = query.eq('agent_config_id', agentConfigId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Delete a lead.
 */
async function deleteLead(id) {
  const { error } = await supabase.from('leads').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = {
  startCall,
  findCallBySid,
  finalizeCall,
  appendTranscript,
  endCall,
  saveRecordingUrl,
  saveSummary,
  saveLead,
  listCalls,
  getCall,
  getStats,
  listLeads,
  deleteLead,
};
