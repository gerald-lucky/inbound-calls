'use strict';

const { createClient } = require('@supabase/supabase-js');

const CHUNK_TOKENS   = 400; // ~300 words per chunk
const OVERLAP_TOKENS = 50;  // ~1–2 sentence overlap

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Chunking ──────────────────────────────────────────────────────────────────
// Rough token estimate: 1 token ≈ 4 characters

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function chunkText(text) {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0);

  const chunks = [];
  let current  = '';

  for (const para of paragraphs) {
    const currentTok = estimateTokens(current);
    const paraTok    = estimateTokens(para);

    if (currentTok + paraTok > CHUNK_TOKENS && current) {
      chunks.push(current.trim());
      const overlapChars = OVERLAP_TOKENS * 4;
      const tail = current.length > overlapChars ? current.slice(-overlapChars) : current;
      current = tail + '\n\n' + para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  // Split any chunk that is still very long (e.g. a single giant paragraph)
  const result = [];
  for (const chunk of chunks) {
    if (estimateTokens(chunk) > CHUNK_TOKENS * 1.5) {
      const sentences = chunk.split(/(?<=[.!?])\s+/);
      let sub = '';
      for (const s of sentences) {
        if (estimateTokens(sub + s) > CHUNK_TOKENS && sub) {
          result.push(sub.trim());
          sub = s;
        } else {
          sub = sub ? sub + ' ' + s : s;
        }
      }
      if (sub.trim()) result.push(sub.trim());
    } else {
      result.push(chunk);
    }
  }

  return result.filter(c => c.length > 30);
}

// ── Embedding via Supabase Edge Function ──────────────────────────────────────
// Uses the gte-small model (384 dimensions, no extra API key needed).
//
// SETUP REQUIRED (one time):
//   1. Supabase Dashboard → Edge Functions → New Function → name it "embed"
//   2. Paste the contents of supabase/functions/embed/index.ts
//   3. Click Deploy
//
// The function must be deployed before ingestion or search will work.

async function embedTexts(texts) {
  const { data, error } = await supabase.functions.invoke('embed', {
    body: { input: texts },
  });

  if (error) {
    console.error('[knowledge] embed function error — is the edge function deployed?', error);
    throw new Error(
      `Embedding failed: ${error.message}. ` +
      'Make sure the "embed" edge function is deployed in your Supabase dashboard ' +
      '(Edge Functions → New Function → paste supabase/functions/embed/index.ts → Deploy).'
    );
  }

  if (!data?.embeddings) {
    console.error('[knowledge] embed function returned unexpected response:', data);
    throw new Error('Embedding function returned no data. Check the edge function logs in your Supabase dashboard.');
  }

  return data.embeddings;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function ingestDocument(filename, text) {
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({ filename, content: text })
    .select()
    .single();
  if (docErr) throw new Error(`Document insert failed: ${docErr.message}`);

  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No content to ingest after chunking.');

  // Embed in batches of 20 (edge function concurrency limit)
  const allEmbeddings = [];
  for (let i = 0; i < chunks.length; i += 20) {
    const batch = chunks.slice(i, i + 20);
    const embeddings = await embedTexts(batch);
    allEmbeddings.push(...embeddings);
  }

  const rows = chunks.map((content, i) => ({
    document_id: doc.id,
    content,
    embedding:   allEmbeddings[i],
    chunk_index: i,
  }));

  const { error: chunkErr } = await supabase.from('document_chunks').insert(rows);
  if (chunkErr) throw new Error(`Chunk insert failed: ${chunkErr.message}`);

  return { id: doc.id, filename, chunks: chunks.length };
}

async function searchKnowledge(query, limit = 5) {
  const [embedding] = await embedTexts([query]);

  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_count:     limit,
    match_threshold: 0.4,
  });

  if (error) throw new Error(`Search failed: ${error.message}`);
  return data || [];
}

async function listDocuments() {
  const { data, error } = await supabase
    .from('documents_with_chunk_count')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

async function deleteDocument(id) {
  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = { ingestDocument, searchKnowledge, listDocuments, deleteDocument, chunkText, embedTexts };
