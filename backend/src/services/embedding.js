'use strict';

// OpenAI text-embedding-3-small with dimensions=384 so the existing
// pgvector column (vector(384)) requires no schema change.
// Requires OPENAI_API_KEY in the environment.

const OpenAI = require('openai');

let _client = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

async function embed(text) {
  const res = await client().embeddings.create({
    model:      'text-embedding-3-small',
    input:      text.replace(/\n/g, ' '),
    dimensions: 384,
  });
  return res.data[0].embedding;
}

async function embedBatch(texts) {
  const res = await client().embeddings.create({
    model:      'text-embedding-3-small',
    input:      texts.map((t) => t.replace(/\n/g, ' ')),
    dimensions: 384,
  });
  // API returns embeddings in the same order as inputs
  return res.data.map((item) => item.embedding);
}

module.exports = { embed, embedBatch };
