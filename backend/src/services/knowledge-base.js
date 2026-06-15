'use strict';

const { createClient } = require('@supabase/supabase-js');
const { embed, embedBatch } = require('./embedding');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const BUCKET        = 'knowledge-base';
const CHUNK_SIZE    = 600;
const CHUNK_OVERLAP = 80;

async function generateEmbeddings(chunks) {
  return embedBatch(chunks);
}

async function generateEmbedding(text) {
  return embed(text);
}

// ── Storage ───────────────────────────────────────────────────────────────────

async function uploadToStorage(buffer, filename, mimeType) {
  const timestamp = Date.now();
  const safeName  = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath  = `${timestamp}_${safeName}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(filePath, buffer, { contentType: mimeType, upsert: false });

  if (error) throw new Error(`Storage upload failed: ${error.message}`);
  return filePath;
}

async function deleteFromStorage(filePath) {
  if (!filePath) return;
  const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
  if (error) console.error('[knowledge-base] Storage delete error:', error.message);
}

// ── Text extraction ───────────────────────────────────────────────────────────

async function extractText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const pdfParse = require('pdf-parse');
    const result   = await pdfParse(buffer);
    return result.text;
  }
  return buffer.toString('utf8');
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks  = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = Math.min(start + CHUNK_SIZE, cleaned.length);
    chunks.push(cleaned.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }

  return chunks.filter((c) => c.length > 20);
}

// ── Document processing pipeline ─────────────────────────────────────────────

async function processDocument(documentId) {
  console.log(`[knowledge-base] processDocument start — ${documentId}`);
  try {
    const { data: doc, error: fetchErr } = await supabase
      .from('documents')
      .select('id, filename, file_path, file_type')
      .eq('id', documentId)
      .single();

    if (fetchErr) throw new Error(`DB fetch error: ${fetchErr.message}`);
    if (!doc)     throw new Error('Document not found in database');

    console.log(`[knowledge-base] Downloading "${doc.filename}" from storage…`);
    const { data: fileData, error: dlErr } = await supabase.storage
      .from(BUCKET)
      .download(doc.file_path);

    if (dlErr) throw new Error(`Storage download failed: ${dlErr.message}`);

    const buffer = Buffer.from(await fileData.arrayBuffer());
    console.log(`[knowledge-base] Extracting text (${buffer.length} bytes, type: ${doc.file_type})…`);

    const text   = await extractText(buffer, doc.file_type);
    const chunks = chunkText(text);

    console.log(`[knowledge-base] Chunked into ${chunks.length} chunk(s)`);
    if (chunks.length === 0) throw new Error('No text content extracted from file');

    console.log(`[knowledge-base] Calling embed Edge Function for ${chunks.length} chunk(s)…`);
    const embeddings = await generateEmbeddings(chunks);
    console.log(`[knowledge-base] Embeddings received (${embeddings.length} vectors, ${embeddings[0]?.length} dims)`);

    const rows = chunks.map((content, idx) => ({
      document_id: documentId,
      content,
      embedding:   JSON.stringify(embeddings[idx]),
      chunk_index: idx,
    }));

    const { error: insertErr } = await supabase
      .from('document_chunks')
      .insert(rows);

    if (insertErr) throw new Error(`Chunk insert failed: ${insertErr.message}`);

    const { error: updateErr } = await supabase
      .from('documents')
      .update({ status: 'ready' })
      .eq('id', documentId);

    if (updateErr) throw new Error(`Status update failed: ${updateErr.message}`);

    console.log(`[knowledge-base] ✓ Processed "${doc.filename}" — ${chunks.length} chunks`);
  } catch (err) {
    console.error(`[knowledge-base] ✗ processDocument(${documentId}) failed:`, err.message);
    const { error: errUpdate } = await supabase
      .from('documents')
      .update({ status: 'error' })
      .eq('id', documentId);
    if (errUpdate) console.error('[knowledge-base] Also failed to set error status:', errUpdate.message);
  }
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

async function listDocuments(agentConfigId) {
  let query = supabase
    .from('documents_with_chunk_count')
    .select('*')
    .order('created_at', { ascending: false });

  if (agentConfigId) query = query.eq('agent_config_id', agentConfigId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function getDocument(id) {
  const { data, error } = await supabase
    .from('documents_with_chunk_count')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function deleteDocument(id) {
  const { data: doc, error: fetchErr } = await supabase
    .from('documents')
    .select('file_path')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) throw new Error(fetchErr.message);
  if (!doc) throw new Error('Document not found');

  const { error: deleteErr } = await supabase
    .from('documents')
    .delete()
    .eq('id', id);

  if (deleteErr) throw new Error(deleteErr.message);

  await deleteFromStorage(doc.file_path);
}

module.exports = {
  uploadToStorage,
  generateEmbedding,
  processDocument,
  listDocuments,
  getDocument,
  deleteDocument,
};
