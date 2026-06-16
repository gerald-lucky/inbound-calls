'use strict';

const path = require('path');

// Cache models in a project-relative directory so Railway can persist it
// via a volume mount on /app/model-cache (more reliable than ~/.cache).
const CACHE_DIR = path.join(__dirname, '../../../model-cache');

let _extractor = null;
let _loadPromise = null; // deduplicate concurrent load calls

async function getExtractor() {
  if (_extractor) return _extractor;

  // If a load is already in progress, wait for it instead of starting another
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    const { pipeline, env } = await import('@xenova/transformers');
    env.cacheDir = CACHE_DIR;
    env.allowLocalModels = false;

    console.log(`[embedding] Loading Xenova/gte-small (cache: ${CACHE_DIR})…`);
    const model = await pipeline('feature-extraction', 'Xenova/gte-small', { quantized: true });
    _extractor = model;
    console.log('[embedding] Model ready');
    return _extractor;
  })().catch((err) => {
    _loadPromise = null; // reset so callers can retry
    throw err;
  });

  return _loadPromise;
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

// Called at server startup to pre-load the model before any uploads arrive.
async function warmup() {
  return getExtractor();
}

module.exports = { embed, embedBatch, warmup };
