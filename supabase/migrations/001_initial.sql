-- Enable pgvector extension
create extension if not exists vector;

-- Documents table: stores the original uploaded file metadata
create table documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  content text not null,
  created_at timestamptz default now()
);

-- Document chunks table: stores chunked text with embeddings
create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  content text not null,
  embedding vector(1536),
  chunk_index integer not null,
  created_at timestamptz default now()
);

-- IVFFlat index for fast approximate nearest-neighbour search
create index on document_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Similarity search function used by the RAG pipeline
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int default 5,
  match_threshold float default 0.7
)
returns table (
  id uuid,
  content text,
  document_id uuid,
  similarity float
)
language sql stable
as $$
  select
    id,
    content,
    document_id,
    1 - (embedding <=> query_embedding) as similarity
  from document_chunks
  where 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- View used by the documents list API (adds chunk count per document)
create view documents_with_chunk_count as
  select
    d.id,
    d.filename,
    d.created_at,
    count(dc.id)::int as chunk_count
  from documents d
  left join document_chunks dc on dc.document_id = d.id
  group by d.id, d.filename, d.created_at
  order by d.created_at desc;
