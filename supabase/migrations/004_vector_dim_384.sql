-- Migration 004: Switch embedding dimensions from 1536 (OpenAI) → 384 (Supabase gte-small)
--
-- Safe to run against an empty document_chunks table.
-- The knowledge base was scaffolded but never activated, so no data is lost.

-- Drop existing objects that depend on the column type
DROP INDEX IF EXISTS document_chunks_embedding_idx;

DROP FUNCTION IF EXISTS match_chunks(vector(1536), int, float);

-- Re-type the embedding column
ALTER TABLE document_chunks
  ALTER COLUMN embedding TYPE vector(384);

-- Recreate the approximate nearest-neighbour index
CREATE INDEX ON document_chunks
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- Recreate the similarity search function with the correct dimension
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding vector(384),
  match_count     int   DEFAULT 5,
  match_threshold float DEFAULT 0.4
)
RETURNS TABLE (
  id          uuid,
  content     text,
  document_id uuid,
  similarity  float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    content,
    document_id,
    1 - (embedding <=> query_embedding) AS similarity
  FROM document_chunks
  WHERE 1 - (embedding <=> query_embedding) > match_threshold
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
