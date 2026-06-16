'use strict';

const { createClient } = require('@supabase/supabase-js');
const { pipeline }     = require('@xenova/transformers');

const CHUNK_TOKENS   = 400; // ~300 words per chunk
const OVERLAP_TOKENS = 50;  // ~1–2 sentence overlap

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

// ── Local embedding model (gte-small, 384 dimensions) ─────────────────────────
// Model is downloaded once on first use (~30 MB) and cached in node_modules/.cache

let _embedder = null;
async function getEmbedder() {
  if (!_embedder) {
    console.log('[knowledge] Loading gte-small embedding model (first run may take a moment)…');
    _embedder = await pipeline('feature-extraction', 'Xenova/gte-small');
    console.log('[knowledge] Embedding model ready.');
  }
  return _embedder;
}

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

// ── Embedding (local, no external API needed) ─────────────────────────────────

async function embedTexts(texts) {
  const embedder = await getEmbedder();
  const results  = [];

  for (const text of texts) {
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(output.data));
  }

  return results;
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

  const allEmbeddings = await embedTexts(chunks);

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
