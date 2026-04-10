'use strict';

const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const knowledgeBase = require('./services/knowledge-base');

// Approximate character count for ~500 tokens (1 token ≈ 4 chars)
const CHUNK_CHARS = 2000;
// Overlap in characters (~50 tokens)
const OVERLAP_CHARS = 200;

/**
 * Extract plain text from an uploaded file buffer.
 *
 * @param {Buffer} buffer - Raw file bytes.
 * @param {string} mimetype - MIME type of the file.
 * @param {string} originalname - Original filename (used for extension fallback).
 * @returns {Promise<string>} Extracted plain text.
 */
async function extractText(buffer, mimetype, originalname) {
  const ext = originalname.split('.').pop().toLowerCase();

  if (mimetype === 'application/pdf' || ext === 'pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    mimetype ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (
    mimetype === 'text/plain' ||
    mimetype === 'text/markdown' ||
    ext === 'txt' ||
    ext === 'md'
  ) {
    return buffer.toString('utf-8');
  }

  throw new Error(`Unsupported file type: ${mimetype} (.${ext})`);
}

/**
 * Split text into overlapping chunks for embedding.
 * Splits on word boundaries to avoid cutting mid-word.
 *
 * @param {string} text
 * @returns {string[]}
 */
function chunkText(text) {
  // Normalise whitespace
  const normalised = text.replace(/\s+/g, ' ').trim();
  if (normalised.length === 0) return [];

  const chunks = [];
  let start = 0;

  while (start < normalised.length) {
    let end = Math.min(start + CHUNK_CHARS, normalised.length);

    // If not at the end, snap to the last word boundary
    if (end < normalised.length) {
      const lastSpace = normalised.lastIndexOf(' ', end);
      if (lastSpace > start) end = lastSpace;
    }

    chunks.push(normalised.slice(start, end).trim());

    // Advance with overlap
    start = end - OVERLAP_CHARS;
    if (start < 0) start = 0;
    // Skip past any leading space after the overlap
    while (start < normalised.length && normalised[start] === ' ') start++;
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Full pipeline: extract → chunk → embed → store.
 *
 * @param {{ buffer: Buffer, mimetype: string, originalname: string }} file
 *   Multer file object (memory storage).
 * @returns {Promise<{ documentId: string, chunkCount: number }>}
 */
async function processDocument(file) {
  const { buffer, mimetype, originalname } = file;

  console.log(`[document-processor] Processing "${originalname}" (${mimetype})`);

  const text = await extractText(buffer, mimetype, originalname);
  if (!text || text.trim().length === 0) {
    throw new Error('No text could be extracted from this file.');
  }

  const chunks = chunkText(text);
  console.log(
    `[document-processor] "${originalname}" → ${chunks.length} chunks`,
  );

  const documentId = await knowledgeBase.storeDocument(
    originalname,
    text,
    chunks,
  );

  return { documentId, chunkCount: chunks.length };
}

module.exports = { processDocument, extractText, chunkText };
