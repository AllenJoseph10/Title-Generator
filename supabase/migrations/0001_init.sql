-- Silent-Video Title Generator — v1.1 schema
-- Single migration. Idempotent. Run via Supabase CLI: `supabase db push`.

create extension if not exists vector with schema extensions;
create extension if not exists pgcrypto;

-- Lookup tables (text PKs so seed values are readable in JOINs)

create table if not exists niches (
  id            text primary key,
  display_name  text not null,
  style_brief   text not null,
  created_at    timestamptz not null default now()
);

create table if not exists hook_families (
  id            text primary key,
  display_name  text not null,
  template_hint text not null,
  created_at    timestamptz not null default now()
);

insert into hook_families (id, display_name, template_hint) values
  ('relatable_pov',         'Relatable POV',           'Me ${verb-ing} ${mundane}…'),
  ('setup_trivial_reveal',  'Setup + Trivial Reveal',  '${grand setup}. ${trivial reveal}:'),
  ('listicle_reveal',       'Listicle Reveal',         'Me and my ${N} ${things}:'),
  ('reaction_humblebrag',   'Reaction Humblebrag',     'When ${X happens} but ${flex}…'),
  ('transformation_tease',  'Transformation Tease',    'Anyone can go from this: / POV: how life feels when ${aspiration}…')
on conflict (id) do nothing;

-- Corpus: hand-curated and (later) scraped exemplar titles.
-- NOTE: NO ivfflat index. Sequential scan wins below ~10k rows.

create table if not exists corpus_titles (
  id                     uuid primary key default gen_random_uuid(),
  niche_id               text not null references niches(id) on delete restrict,
  title                  text not null,
  hook_family            text not null references hook_families(id) on delete restrict,
  save_rate_estimate     real,
  share_rate_estimate    real,
  source_url             text,
  source_platform        text,
  embedding              extensions.vector(1536),
  scraped_at             timestamptz not null default now()
);

create index if not exists corpus_titles_niche_family_idx
  on corpus_titles (niche_id, hook_family);

create table if not exists creator_style_fingerprints (
  creator_handle  text primary key,
  best_titles     text[] not null,
  voice_notes     text,
  niche_id        text not null references niches(id) on delete restrict,
  created_at      timestamptz not null default now()
);

-- generation_attempts logs every pipeline START. Generations table is only written
-- on total success. This lets us cost-audit failed runs without polluting `generations`.

create table if not exists generation_attempts (
  id                       uuid primary key default gen_random_uuid(),
  client_request_id        text not null,
  storage_path             text not null,
  niche_id                 text not null references niches(id) on delete restrict,
  vision_provider          text not null,
  generation_provider      text not null,
  passcode_session_hash    text not null,
  started_at               timestamptz not null default now(),
  failed_at                timestamptz,
  failure_stage            text,
  failure_message          text
);

create index if not exists generation_attempts_session_started_idx
  on generation_attempts (passcode_session_hash, started_at);

create table if not exists generations (
  id                       uuid primary key references generation_attempts(id) on delete cascade,
  client_request_id        text not null unique,
  vision_description       jsonb not null,
  retrieved_corpus_ids     uuid[] not null,
  generated_titles         jsonb not null,
  cost_usd                 numeric(10, 6) not null,
  tokens_in                integer not null,
  tokens_out               integer not null,
  duration_ms              integer not null,
  completed_at             timestamptz not null default now()
);

create table if not exists title_feedback (
  generation_id  uuid not null references generations(id) on delete cascade,
  title_index    smallint not null,
  vote           smallint not null check (vote in (-1, 1)),
  created_at     timestamptz not null default now(),
  primary key (generation_id, title_index)
);

-- Cost view for Vercel cron alerting (Step 5).

create or replace view cost_per_day as
  select date_trunc('day', completed_at) as day,
         count(*) as generations,
         sum(cost_usd) as total_cost_usd
    from generations
   group by 1
   order by 1 desc;

-- Deny-all RLS on every table. Service role bypasses; anon/auth get nothing.

alter table niches                       enable row level security;
alter table hook_families                enable row level security;
alter table corpus_titles                enable row level security;
alter table creator_style_fingerprints   enable row level security;
alter table generation_attempts          enable row level security;
alter table generations                  enable row level security;
alter table title_feedback               enable row level security;
