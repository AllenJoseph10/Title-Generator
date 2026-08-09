# Title feedback loop — design

**Date:** 2026-08-09
**Branch:** `feauture/likes`

The thumbs up/down controls on each generated title currently write to
`title_feedback` and **nothing reads that table**. This makes the votes
load-bearing: a dislike reshapes the next regenerate for the clip on screen, a
like accumulates as a voice signal for that creator, and both become reviewable
by a human.

---

## Decisions

| Question | Decision |
|---|---|
| When does a vote take effect? | Split — dislikes affect only the current clip; likes persist per creator |
| Do likes need approval before use? | No. Immediate, capped and recent |
| How are likes matched to a new video? | Embedded, retrieved by visual-description similarity |
| Where do liked titles live? | A new table, never `corpus_titles` |
| Admin surface | Generated Markdown review file |

### Why likes must not enter `corpus_titles`

`corpus_titles.performance_score` is the percentile rank of measured share rate,
and it is the ground truth the eval scores against. Percentiles are
corpus-relative, which is why `import-dataset.ts` replaces the whole table
rather than appending — appending rows carrying stale percentiles invalidates
every existing score.

A liked title was never posted and has no share data. Writing human approval
into the same column as earned shares would corrupt the eval's ground truth
silently, and would repeat the likes-swamp-shares category error recorded in
`docs/findings/2026-08-02-performance-metric-decision.md`.

Liked titles therefore live in their own table, carry **no** performance score,
and are labelled in the prompt as a voice signal rather than evidence.

---

## Data model

### Two tables, deliberately

- **`title_feedback` is the ledger.** Every vote, both directions, kept forever.
  The review file reads this. Unchanged by this work.
- **`liked_titles` is a derived index.** Likes only, capped to the most recent
  50 per creator, carrying the embedding used for retrieval.

The split exists because of the "capped and recent" decision: pruning the index
must not destroy audit history, which it would if the cap were applied to the
ledger.

### New table

```sql
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
```

`title` and `visual_description` are **copied, not joined**. The row is
self-contained, so neither the generation path nor the review file needs a join
at request time.

No `ivfflat` index, for the same reason `0001_init.sql` gives: sequential scan
wins well below ~10k rows, and this table is capped at 50 per creator.

### Attribution gap to close

`creator_handle` is currently **not persisted anywhere**. `/api/generate`
receives it, uses it to look up the style fingerprint, and drops it. Add:

```sql
alter table generation_attempts add column if not exists creator_handle text;
```

and record it on insert. Without this, a vote can only be attributed to a
creator by trusting the client.

### Migration note

Per `docs/SESSION-HANDOFF.md`, migrations must be applied **by hand in the
Supabase dashboard** — the CLI is authenticated against a different account than
the client project, and the service-role key cannot run DDL. This migration is
no exception.

---

## Flow

### On like (`POST /api/feedback`, vote `1`)

1. Upsert the ledger row, as today.
2. Read the generation: `generations.vision_description` and
   `generations.generated_titles[title_index]` for the title text and hook
   family, plus `creator_handle` and `niche_id` from the matching
   `generation_attempts` row (same `id`). Nothing is taken from the client
   beyond `generation_id` / `title_index` / `vote`.
3. Rebuild the **same** `` `${scene} ${visualHook}` `` string the orchestrator
   embeds at query time.
4. Embed it with `text-embedding-3-small` (1536-dim).
5. Insert into `liked_titles`.
6. Delete rows beyond the newest 50 for that `creator_handle`, oldest first by
   `created_at`.

If the embedding call fails, the ledger row still stands and the endpoint still
returns `ok` — a like that fails to index is a missed voice signal, not a lost
vote, and must not surface as an error on a thumbs-up click.

Rebuilding that exact string is what puts liked-title vectors in the same space
as `corpus_titles.description_embedding`, so similarity numbers mean the same
thing on both sides.

### On dislike (`POST /api/feedback`, vote `-1`)

Ledger row only. Nothing embedded, nothing stored for reuse.

### On generate

After the existing corpus retrieval, one additional RPC that mirrors
`match_corpus_titles`:

```sql
match_liked_titles(
  p_creator_handle text,
  p_query_embed    extensions.vector(1536),
  p_match_limit    int default 3
)
returns table (title text, hook_family text, visual_description text, similarity real)
```

It reuses the query vector the orchestrator already computed, so there is **no
extra embedding call on the generation path** — only one RPC against a table
holding tens of rows.

Results below a similarity floor are dropped, so an approved suit-fitting title
stays silent on a car video. Ship with `LIKED_MIN_SIMILARITY = 0.5` in
`lib/retrieval/constants.ts`.

**That number is a hypothesis, not a decision.** `npm run verify:retrieval`
recorded 0.57–0.91 for genuine description-space neighbours and 0.34–0.51 for
the title-space comparison that turned out to be near noise, so 0.5 sits just
below the genuine-neighbour band. It needs checking against real votes before
it is trusted, and the constant carries a comment saying so.

---

## Prompt integration

### Liked titles

Into `buildUserMessage`, **not** `buildCreatorBlock`. The creator block is the
cached prefix carrying `cache_control: ephemeral`; injecting per-video retrieved
content there would invalidate the cache on every request. The user message
already varies per video.

Placed after the mimic examples, before the contrast block:

```
## Titles this creator kept, for videos like this one
Generated earlier and approved by the creator. They carry no performance data —
this is a voice signal, not evidence that a pattern earns shares. Weight them
for phrasing and tone, not as proof.
- [hook_family] "title"
  written for: <visual description>
```

The labelling is load-bearing. If approval and measured share rate arrive
through the same channel, the model cannot distinguish "a human liked this" from
"this earned shares".

### Disliked titles

A separate block — **not** folded into the existing "Titles that did NOT land"
section. That section is framed as real titles that ranked near the bottom of the
corpus on share rate; a rejected suggestion is neither real nor measured, and
filing it there would tell the model something untrue.

```
## Rejected for THIS video
The creator saw these for this exact clip and rejected them. Do not produce
these or close variants.
- title
```

### Request shape

`/api/generate` gains optional `avoid_titles: string[]`. It is client-supplied
text entering a prompt, so it is sanitised rather than trusted: non-strings
dropped, empty and whitespace-only entries dropped, each entry truncated to 200
characters, and the list truncated to the first 10. A malformed value degrades
to an empty list rather than rejecting the request — a bad avoid list should not
cost the user their generation.

`TitleList` reports its disliked title texts upward via a callback so the page
can pass them on regenerate. The component keeps owning its own vote state.

---

## Admin review file

`npm run review:feedback` → `scripts/review-feedback.ts` → writes
`datasets/raw/_title-feedback.md`.

Mirrors `datasets/raw/_quarantine-review.md`: grouped by creator, each entry
showing the vote, the title, its hook family, the visual description it was
generated for, the generation id, and the date. A summary header carries counts
and the date range.

Generated on demand rather than written on every vote. `datasets/raw/` is
gitignored, so creator content stays out of the repo.

---

## Testing

Following the repo's existing style — pure functions, vitest, no DB and no
network:

| Unit | Test |
|---|---|
| Prune-to-N selection | Given rows and a cap, the right ones are dropped; ties broken by `created_at` |
| Similarity floor filter | Rows below the floor are excluded; boundary passes |
| Liked-titles prompt block | Heading present, descriptions rendered, empty input yields empty string |
| Rejected-titles prompt block | Heading present, empty input yields empty string |
| `avoid_titles` sanitisation | Count cap, length cap, non-strings and empties dropped |
| Markdown renderer | Given rows, produces stable grouped output |

Patterned on `lib/prompts/generate.test.ts` and `lib/retrieval/contrast.test.ts`.

---

## What this deliberately does not do

- **Does not touch `corpus_titles`** or anything the eval reads. The 0.261
  baseline in `EVAL.md` is unaffected.
- **Does not score liked titles.** No performance number is attached, so nothing
  invites ranking them against measured corpus rows.
- **Does not gate likes behind approval.** The brakes on drift are the 50-row
  cap, the similarity floor, and the prompt labelling — not a review step.

### Honest limitation

**There is no way to measure whether this helps.** The eval scores real corpus
rows with known share rates; it cannot score generated titles, which is the
reason it holds out corpus rows in the first place (`EVAL.md`, "How it works").
This ships as a judgement call, not a measured improvement. The review file is
what makes that judgement possible from real votes.

### Scope note

`app/(app)/page.tsx` currently hardcodes `creator_handle: 'william_j_wade'`, so
"per creator" is effectively one creator until the niche selector (deliverable 5)
lands. The design generalises unchanged when it does.
