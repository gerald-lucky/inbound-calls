'use strict';

// Local embedding via @xenova/transformers (Xenova/gte-small, 384 dims).
// Model is downloaded once (~21 MB, quantized) to ~/.cache/huggingface/hub/
// and reused on subsequent runs. No API key or external service required.

let extractor = null;

async function getExtractor() {
  if (extractor) return extractor;
  const { pipeline } = await import('@xenova/transformers');
  console.log('[embedding] Loading Xenova/gte-small (downloads ~21 MB on first run)…');
  extractor = await pipeline('feature-extraction', 'Xenova/gte-small', { quantized: true });
  console.log('[embedding] Model ready');
  return extractor;
}

async function embed(text) {
  const model = await getExtractor();
  const out   = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

async function embedBatch(texts) {
  const model = await getExtractor();
  const results = [];
  for (const text of texts) {
    const out = await model(text, { pooling: 'mean', normalize: true });
    results.push(Array.from(out.data));
  }
  return results;
}

module.exports = { embed, embedBatch };
