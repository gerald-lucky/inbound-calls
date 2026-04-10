'use strict';

const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Embed a piece of text using OpenAI text-embedding-3-small (1536 dims).
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function embed(text) {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

/**
 * Retrieve the top-k most relevant knowledge base chunks for a given query.
 * Returns a single string of concatenated chunks, ready to inject into the
 * Claude system prompt.
 *
 * @param {string} query - The user's utterance.
 * @param {number} k - Max number of chunks to return (default 5).
 * @param {number} threshold - Minimum cosine similarity (default 0.7).
 * @returns {Promise<string>} Relevant context, or empty string if none found.
 */
async function search(query, k = 5, threshold = 0.7) {
  let embedding;
  try {
    embedding = await embed(query);
  } catch (err) {
    console.error('[knowledge-base] Embedding failed:', err.message);
    return '';
  }

  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: embedding,
    match_count: k,
    match_threshold: threshold,
  });

  if (error) {
    console.error('[knowledge-base] Supabase search error:', error.message);
    return '';
  }

  if (!data || data.length === 0) return '';

  return data.map((row) => row.content).join('\n\n---\n\n');
}

/**
 * Store a document record and its embedded chunks in Supabase.
 *
 * @param {string} filename
 * @param {string} fullText - Full extracted text of the document.
 * @param {string[]} chunks - Array of chunked text strings.
 * @returns {Promise<string>} The new document's UUID.
 */
async function storeDocument(filename, fullText, chunks) {
  // Insert the document
  const { data: doc, error: docErr } = await supabase
    .from('documents')
    .insert({ filename, content: fullText })
    .select('id')
    .single();

  if (docErr) throw new Error(`Failed to insert document: ${docErr.message}`);

  const documentId = doc.id;

  // Embed all chunks in parallel (batched to avoid rate limits)
  const BATCH_SIZE = 20;
  const rows = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((c) => embed(c)));
    for (let j = 0; j < batch.length; j++) {
      rows.push({
        document_id: documentId,
        content: batch[j],
        embedding: embeddings[j],
        chunk_index: i + j,
      });
    }
  }

  const { error: chunkErr } = await supabase.from('document_chunks').insert(rows);
  if (chunkErr) throw new Error(`Failed to insert chunks: ${chunkErr.message}`);

  return documentId;
}

/**
 * List all documents (with chunk counts) from the view.
 * @returns {Promise<Array>}
 */
async function listDocuments() {
  const { data, error } = await supabase
    .from('documents_with_chunk_count')
    .select('*');
  if (error) throw new Error(error.message);
  return data;
}

/**
 * Delete a document (chunks cascade via foreign key).
 * @param {string} id - UUID
 */
async function deleteDocument(id) {
  const { error } = await supabase.from('documents').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

module.exports = { search, storeDocument, listDocuments, deleteDocument, embed };
