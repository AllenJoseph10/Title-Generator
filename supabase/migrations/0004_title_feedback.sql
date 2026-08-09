-- Title feedback loop. See docs/superpowers/specs/2026-08-09-title-feedback-loop-design.md
--
-- WHY A SEPARATE TABLE FROM corpus_titles
--
-- corpus_titles.performance_score is the percentile rank of measured share
-- rate and is the ground truth the eval scores against. Percentiles are
-- corpus-relative, which is why import-dataset.ts replaces the whole table.
-- A liked title was never posted and has no share data at all. Writing human
-- approval into that column would corrupt the eval silently.
--
-- WHY A SEPARATE TABLE FROM title_feedback
--
-- title_feedback is the permanent ledger of every vote and feeds the admin
-- review file. liked_titles is a derived index, capped at the newest 50 per
-- creator. Pruning the index must not delete audit history.

alter table generation_attempts
  add column if not exists creator_handle text;

comment on column generation_attempts.creator_handle is
  'Whose voice this generation targeted. Previously accepted by /api/generate and dropped, which left votes unattributable without trusting the client.';

create table if not exists liked_titles (
  id                    uuid primary key default gen_random_uuid(),
  generation_id         uuid not null references generations(id) on delete cascade,
  title_index           smallint not null,
  creator_handle        text not null,
  niche_id              text not null references niches(id) on delete restrict,
  title                 text not null,
  hook_family           text not null,
  visual_description    text not null,
  description_embedding extensions.vector(1536) not null,
  created_at            timestamptz not null default now(),
  unique (generation_id, title_index)
);

comment on table liked_titles is
  'Titles a human kept. A VOICE signal only — deliberately has no performance column, because nothing here was ever posted or measured.';
comment on column liked_titles.visual_description is
  'The exact `scene + visualHook` string description_embedding was computed from, so these vectors share a space with corpus_titles.description_embedding.';

create index if not exists liked_titles_creator_idx on liked_titles (creator_handle, created_at desc);

alter table liked_titles enable row level security;

-- No ivfflat index: sequential scan wins well below ~10k rows (see 0001), and
-- this table is capped at 50 rows per creator.
create or replace function match_liked_titles(
  p_creator_handle text,
  p_query_embed    extensions.vector(1536),
  p_match_limit    int default 3
)
returns table (
  title              text,
  hook_family        text,
  visual_description text,
  similarity         real
)
language sql
stable
as $$
  select
    l.title,
    l.hook_family,
    l.visual_description,
    (1 - (l.description_embedding <=> p_query_embed))::real as similarity
  from liked_titles l
  where l.creator_handle = p_creator_handle
  order by l.description_embedding <=> p_query_embed
  limit p_match_limit;
$$;

grant execute on function match_liked_titles(text, extensions.vector(1536), int) to service_role;
