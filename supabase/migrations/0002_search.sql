-- Retrieval RPC for /api/generate. Sequential scan + cosine distance order.
-- pgvector `<=>` is cosine DISTANCE (smaller = closer). We expose 1 - distance
-- as `similarity` so consumers don't have to remember to invert.

create or replace function match_corpus_titles(
  p_niche_id      text,
  p_query_embed   extensions.vector(1536),
  p_match_limit   int default 30
)
returns table (
  id                     uuid,
  title                  text,
  hook_family            text,
  save_rate_estimate     real,
  embedding              extensions.vector(1536),
  similarity             real
)
language sql
stable
as $$
  select
    c.id,
    c.title,
    c.hook_family,
    c.save_rate_estimate,
    c.embedding,
    (1 - (c.embedding <=> p_query_embed))::real as similarity
  from corpus_titles c
  where c.niche_id = p_niche_id
    and c.embedding is not null
  order by c.embedding <=> p_query_embed
  limit p_match_limit;
$$;

-- Service role bypasses RLS but PostgREST still wants the function exposed.
grant execute on function match_corpus_titles(text, extensions.vector(1536), int) to service_role;
