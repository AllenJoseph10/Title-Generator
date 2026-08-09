# Title Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the thumbs up/down votes load-bearing — a dislike reshapes the next regenerate for the clip on screen, a like accumulates as a per-creator voice signal retrieved by visual similarity, and both become reviewable in a generated Markdown file.

**Architecture:** Votes keep landing in `title_feedback` (the ledger, unchanged). A like additionally embeds the visual description its video was generated from and inserts into a new `liked_titles` table, capped at the newest 50 per creator. At generation time a second pgvector RPC pulls the top 3 liked titles whose original video resembles the current one, and they enter the prompt as a labelled voice-signal block — separate from corpus examples, carrying no performance score. Dislikes ride the regenerate request as `avoid_titles` and enter their own labelled block.

**Tech Stack:** Next.js 15 App Router (Node runtime), Supabase Postgres + pgvector, OpenAI `text-embedding-3-small` (1536-dim), vitest.

## Global Constraints

- **Never write to `corpus_titles`.** It holds measured share-rate percentiles and is the eval's ground truth. Liked titles carry no performance score anywhere.
- **Migrations are applied by hand in the Supabase dashboard.** The CLI is authenticated against a different account and the service-role key cannot run DDL (`docs/SESSION-HANDOFF.md`).
- **Embedding text must be exactly** `` `${scene} ${visualHook}` `` — the same string `lib/generation/orchestrator.ts` embeds at query time. Any deviation puts liked-title vectors in a different space from `corpus_titles.description_embedding`.
- Cap: **50** liked rows per creator. Retrieval limit: **3**. Similarity floor: **0.5**.
- `avoid_titles`: max **10** entries, each truncated to **200** chars.
- Tests are pure functions only — no DB, no network. Follow `lib/retrieval/contrast.test.ts`.
- Run `npm run typecheck && npm test` before every commit.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/0004_title_feedback.sql` (create) | `liked_titles` table, `match_liked_titles` RPC, `generation_attempts.creator_handle` |
| `lib/feedback/rules.ts` (create) | Pure: sanitise `avoid_titles`, choose prune victims |
| `lib/feedback/rules.test.ts` (create) | Tests for the above |
| `lib/retrieval/constants.ts` (modify) | `LIKED_MATCH_LIMIT`, `LIKED_MIN_SIMILARITY` |
| `lib/retrieval/liked.ts` (create) | Server-only: call `match_liked_titles`, apply floor |
| `lib/prompts/generate.ts` (modify) | `buildLikedBlock`, `buildRejectedBlock`, wired into `buildUserMessage` |
| `lib/prompts/generate.test.ts` (modify) | Tests for both blocks |
| `lib/providers/types.ts` (modify) | `LikedTitle` type, extend `GenerateArgs` |
| `lib/generation/orchestrator.ts` (modify) | Retrieve likes, thread `avoidTitles` through |
| `app/api/feedback/route.ts` (modify) | Index a like into `liked_titles` |
| `app/api/generate/route.ts` (modify) | Accept `avoid_titles`, persist `creator_handle` |
| `components/app/title-list.tsx` (modify) | Report disliked titles upward |
| `app/(app)/page.tsx` (modify) | Hold disliked titles, send on regenerate |
| `scripts/lib/feedback-report.ts` (create) | Pure: rows → Markdown |
| `scripts/lib/feedback-report.test.ts` (create) | Tests for the renderer |
| `scripts/review-feedback.ts` (create) | Read Postgres, write the review file |
| `package.json` (modify) | `review:feedback` script |

---

### Task 1: Migration

**Files:**
- Create: `supabase/migrations/0004_title_feedback.sql`

**Interfaces:**
- Produces: table `liked_titles`; RPC `match_liked_titles(p_creator_handle text, p_query_embed vector(1536), p_match_limit int)`; column `generation_attempts.creator_handle`.

- [ ] **Step 1: Write the migration**

```sql
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
```

- [ ] **Step 2: Apply it by hand**

Open the Supabase dashboard SQL editor for project `afywfsakawcknolsmgwi`, paste the file, run it. The CLI cannot do this — it is logged into a different account.

- [ ] **Step 3: Verify**

Run in the SQL editor. Expected: one row, `count = 0`.

```sql
select count(*) from liked_titles;
select proname from pg_proc where proname = 'match_liked_titles';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0004_title_feedback.sql
git commit -m "Add liked_titles, its match RPC, and creator_handle on attempts"
```

---

### Task 2: Pure feedback rules

**Files:**
- Create: `lib/feedback/rules.ts`
- Test: `lib/feedback/rules.test.ts`

**Interfaces:**
- Produces: `sanitizeAvoidTitles(input: unknown): string[]`, `aboveFloor<T extends {similarity: number}>(rows: T[], floor: number): T[]`, `prunableIds(rows: Array<{id: string; created_at: string}>, cap: number): string[]`, `MAX_AVOID_TITLES`, `MAX_AVOID_LENGTH`, `LIKED_CAP_PER_CREATOR`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeAvoidTitles, prunableIds, aboveFloor } from './rules';

describe('sanitizeAvoidTitles', () => {
  it('drops non-strings, empties and whitespace-only entries', () => {
    expect(sanitizeAvoidTitles(['a', '', '   ', 3, null, 'b'])).toEqual(['a', 'b']);
  });

  it('truncates each entry to 200 characters', () => {
    const long = 'x'.repeat(250);
    expect(sanitizeAvoidTitles([long])[0]).toHaveLength(200);
  });

  it('keeps only the first 10 entries', () => {
    const many = Array.from({ length: 25 }, (_, i) => `t${i}`);
    expect(sanitizeAvoidTitles(many)).toHaveLength(10);
  });

  it('degrades to an empty list rather than throwing', () => {
    expect(sanitizeAvoidTitles(undefined)).toEqual([]);
    expect(sanitizeAvoidTitles('not an array')).toEqual([]);
    expect(sanitizeAvoidTitles({ 0: 'a' })).toEqual([]);
  });
});

describe('aboveFloor', () => {
  const rows = [{ similarity: 0.9 }, { similarity: 0.5 }, { similarity: 0.49 }];

  it('keeps rows at or above the floor and drops the rest', () => {
    expect(aboveFloor(rows, 0.5)).toEqual([{ similarity: 0.9 }, { similarity: 0.5 }]);
  });

  it('can drop everything', () => {
    expect(aboveFloor(rows, 0.95)).toEqual([]);
  });
});

describe('prunableIds', () => {
  const rows = [
    { id: 'newest', created_at: '2026-08-09T00:00:03Z' },
    { id: 'middle', created_at: '2026-08-09T00:00:02Z' },
    { id: 'oldest', created_at: '2026-08-09T00:00:01Z' },
  ];

  it('returns nothing when under the cap', () => {
    expect(prunableIds(rows, 5)).toEqual([]);
  });

  it('returns nothing when exactly at the cap', () => {
    expect(prunableIds(rows, 3)).toEqual([]);
  });

  it('drops the oldest first', () => {
    expect(prunableIds(rows, 2)).toEqual(['oldest']);
    expect(prunableIds(rows, 1)).toEqual(['middle', 'oldest']);
  });

  it('does not assume the input is sorted', () => {
    const shuffled = [rows[2], rows[0], rows[1]];
    expect(prunableIds(shuffled, 2)).toEqual(['oldest']);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/feedback/rules.test.ts`
Expected: FAIL — cannot find module `./rules`.

- [ ] **Step 3: Implement**

```ts
// Pure rules for the title feedback loop. No DB, no network — every decision
// here is testable in isolation.

// Client-supplied text that enters a prompt. Bounded rather than trusted.
export const MAX_AVOID_TITLES = 10;
export const MAX_AVOID_LENGTH = 200;

// Newest N liked rows kept per creator. The ledger (title_feedback) is never
// pruned — only this derived index is.
export const LIKED_CAP_PER_CREATOR = 50;

// A malformed avoid list degrades to empty rather than rejecting the request:
// a bad list should not cost the user their generation.
export function sanitizeAvoidTitles(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => t.slice(0, MAX_AVOID_LENGTH))
    .slice(0, MAX_AVOID_TITLES);
}

// Similarity floor. Trivial, but it is the rule that decides whether a kept
// title is about the same kind of video, so it gets a boundary test rather
// than living inline as an untested `.filter`.
export function aboveFloor<T extends { similarity: number }>(rows: T[], floor: number): T[] {
  return rows.filter((r) => r.similarity >= floor);
}

// Which rows to delete so at most `cap` survive. Oldest go first. Sorts its
// own input rather than trusting caller ordering.
export function prunableIds(
  rows: Array<{ id: string; created_at: string }>,
  cap: number,
): string[] {
  if (rows.length <= cap) return [];
  return [...rows]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(cap)
    .map((r) => r.id);
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run lib/feedback/rules.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm test
git add lib/feedback/rules.ts lib/feedback/rules.test.ts
git commit -m "Add pure rules for avoid-list sanitising and liked-title pruning"
```

---

### Task 3: Prompt blocks

**Files:**
- Modify: `lib/providers/types.ts`
- Modify: `lib/prompts/generate.ts`
- Test: `lib/prompts/generate.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: type `LikedTitle = { title: string; hookFamily: string; visualDescription: string }`; `buildLikedBlock(likes: LikedTitle[]): string`; `buildRejectedBlock(titles: string[]): string`. `buildUserMessage` gains optional `likedTitles` and `avoidTitles`.

- [ ] **Step 1: Write the failing test** (append to `lib/prompts/generate.test.ts`)

```ts
import { buildLikedBlock, buildRejectedBlock } from './generate';

describe('buildLikedBlock', () => {
  const like = {
    title: 'The coat that does all the work',
    hookFamily: 'transformation_tease',
    visualDescription: 'man in a wool overcoat on a city street at dusk',
  };

  it('is empty when there is nothing to show', () => {
    expect(buildLikedBlock([])).toBe('');
  });

  it('renders the title, its family and the description it was written for', () => {
    const out = buildLikedBlock([like]);
    expect(out).toContain('## Titles this creator kept');
    expect(out).toContain(like.title);
    expect(out).toContain('transformation_tease');
    expect(out).toContain('written for: man in a wool overcoat');
  });

  it('states these carry no performance data', () => {
    // Load-bearing: without it the model cannot tell human approval from
    // measured share rate, which is the conflation the corpus design avoids.
    expect(buildLikedBlock([like]).toLowerCase()).toContain('no performance data');
  });
});

describe('buildRejectedBlock', () => {
  it('is empty when there is nothing to reject', () => {
    expect(buildRejectedBlock([])).toBe('');
  });

  it('renders each rejected title under its own heading', () => {
    const out = buildRejectedBlock(['a bad line', 'another bad line']);
    expect(out).toContain('## Rejected for THIS video');
    expect(out).toContain('- a bad line');
    expect(out).toContain('- another bad line');
  });

  it('is not the corpus contrast block', () => {
    // The contrast block claims its titles ranked near the bottom on share
    // rate. Rejected suggestions were never posted, so they must not be
    // filed under that claim.
    expect(buildRejectedBlock(['x'])).not.toContain('share rate');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run lib/prompts/generate.test.ts`
Expected: FAIL — `buildLikedBlock is not a function`.

- [ ] **Step 3: Add the type**

In `lib/providers/types.ts`, after `CorpusTitle`:

```ts
// A title a human kept, plus the video it was written for. Deliberately has no
// performance score: it was never posted, so there is nothing to measure.
export type LikedTitle = {
  title: string;
  hookFamily: string;
  visualDescription: string;
};
```

Then extend `GenerateArgs` (same file) with two optional fields:

```ts
  likedTitles?: LikedTitle[];
  avoidTitles?: string[];
```

- [ ] **Step 4: Implement the blocks**

In `lib/prompts/generate.ts`, import `LikedTitle` alongside the existing type imports and add:

```ts
// Titles a human kept for visually similar videos.
//
// These are a VOICE signal, not evidence. They were generated, approved, and
// never posted — no share data exists for any of them. The disclaimer is
// load-bearing: corpus examples in the block above carry real measured
// percentiles, and if approval arrives through the same channel the model
// cannot tell the two apart.
export function buildLikedBlock(likes: LikedTitle[]): string {
  if (likes.length === 0) return '';
  const rows = likes
    .map((l) => `- [${l.hookFamily}] ${l.title}\n  written for: ${l.visualDescription}`)
    .join('\n');
  return `

## Titles this creator kept, for videos like this one
Generated earlier and approved by the creator. They carry no performance data — this is a voice signal, not evidence that a pattern earns shares. Weight them for phrasing and tone, not as proof.
${rows}`;
}

// Titles the creator rejected for THIS clip.
//
// Deliberately not folded into the contrast block above: that block states its
// titles ranked near the bottom of the corpus on share rate, which is a claim
// about measured data. A rejected suggestion was never posted.
export function buildRejectedBlock(titles: string[]): string {
  if (titles.length === 0) return '';
  return `

## Rejected for THIS video
The creator saw these for this exact clip and rejected them. Do not produce these or close variants.
${titles.map((t) => `- ${t}`).join('\n')}`;
}
```

- [ ] **Step 5: Wire them into `buildUserMessage`**

Extend the args type with `likedTitles?: LikedTitle[]` and `avoidTitles?: string[]`, then insert the blocks — liked after the mimic examples, rejected after the contrast block:

```ts
  const likedBlock = buildLikedBlock(args.likedTitles ?? []);
  const rejectedBlock = buildRejectedBlock(args.avoidTitles ?? []);
```

and in the returned template string, place `${likedBlock}` immediately after the `Do not carry a specific quantity…` line and `${rejectedBlock}` immediately after `${contrastBlock}`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run lib/prompts/generate.test.ts`
Expected: PASS — the six new tests plus the 13 existing ones.

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npm test
git add lib/prompts/generate.ts lib/prompts/generate.test.ts lib/providers/types.ts
git commit -m "Add labelled prompt blocks for kept and rejected titles"
```

---

### Task 4: Liked-title retrieval

**Files:**
- Modify: `lib/retrieval/constants.ts`
- Create: `lib/retrieval/liked.ts`

**Interfaces:**
- Consumes: `LikedTitle` (Task 3), `aboveFloor` (Task 2).
- Produces: `matchLikedTitles(creatorHandle: string, queryEmbedding: number[]): Promise<LikedTitle[]>`, `LIKED_MATCH_LIMIT`, `LIKED_MIN_SIMILARITY`.

- [ ] **Step 1: Add the constants**

Append to `lib/retrieval/constants.ts`:

```ts
// Liked-title retrieval. Small on purpose: these are a voice nudge, not the
// main example set, and they compete with corpus examples for attention.
export const LIKED_MATCH_LIMIT = 3;

// Below this, a liked title is about a different kind of video and stays
// silent. STARTING HYPOTHESIS, NOT A MEASURED VALUE: `npm run verify:retrieval`
// recorded 0.57-0.91 for genuine description-space neighbours and 0.34-0.51 for
// the title-space comparison that proved to be near noise, so 0.5 sits just
// under the genuine band. Check it against real votes before trusting it.
export const LIKED_MIN_SIMILARITY = 0.5;
```

- [ ] **Step 2: Implement the retrieval**

Create `lib/retrieval/liked.ts`. Mirrors `search.ts`, including its `throw` on RPC error.

```ts
import 'server-only';
import { db } from '@/lib/db/client';
import type { LikedTitle } from '@/lib/providers/types';
import { aboveFloor } from '@/lib/feedback/rules';
import { LIKED_MATCH_LIMIT, LIKED_MIN_SIMILARITY } from './constants';

type Row = {
  title: string;
  hook_family: string;
  visual_description: string;
  similarity: number;
};

// Reuses the query vector the orchestrator already computed for corpus
// retrieval — no extra embedding call on the generation path.
export async function matchLikedTitles(
  creatorHandle: string,
  queryEmbedding: number[],
): Promise<LikedTitle[]> {
  const rpc = await db().rpc('match_liked_titles', {
    p_creator_handle: creatorHandle,
    p_query_embed: queryEmbedding as unknown as string, // pgvector accepts a JSON array
    p_match_limit: LIKED_MATCH_LIMIT,
  });
  if (rpc.error) throw new Error(`liked retrieve: ${rpc.error.message}`);

  return aboveFloor((rpc.data ?? []) as Row[], LIKED_MIN_SIMILARITY)
    .map((r) => ({
      title: r.title,
      hookFamily: r.hook_family,
      visualDescription: r.visual_description,
    }));
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
npm test
git add lib/retrieval/constants.ts lib/retrieval/liked.ts
git commit -m "Retrieve kept titles by visual similarity, behind a floor"
```

---

### Task 5: Thread likes and rejections through generation

**Files:**
- Modify: `lib/generation/orchestrator.ts`
- Modify: `lib/providers/anthropic/generation.ts`
- Modify: `lib/providers/openai/generation.ts`

**Interfaces:**
- Consumes: `matchLikedTitles` (Task 4), `LikedTitle` and the extended `GenerateArgs` (Task 3).
- Produces: `PipelineInput` gains `creatorHandle: string` and `avoidTitles?: string[]`.

- [ ] **Step 1: Extend `PipelineInput`**

In `lib/generation/orchestrator.ts`:

```ts
  creatorHandle: string;
  avoidTitles?: string[];
```

- [ ] **Step 2: Retrieve likes after corpus retrieval**

Immediately after the `retrieveAndRerank` call, before `requiredFamilies` is computed:

```ts
  // A failure here must not cost the user their generation: kept titles are a
  // nudge, and the corpus examples above are the real signal.
  const likedTitles = await matchLikedTitles(input.creatorHandle, queryEmbed.vector).catch(
    (e: Error) => {
      console.warn(`liked retrieve failed, continuing without: ${e.message}`);
      return [];
    },
  );
```

Import `matchLikedTitles` from `@/lib/retrieval/liked`.

- [ ] **Step 3: Pass both through to the generator**

Add to the `generator.generate({ … })` call:

```ts
      likedTitles,
      avoidTitles: input.avoidTitles,
```

- [ ] **Step 4: Forward them in both providers**

In `lib/providers/anthropic/generation.ts` and `lib/providers/openai/generation.ts`, find the `buildUserMessage({ … })` call and add:

```ts
      likedTitles: args.likedTitles,
      avoidTitles: args.avoidTitles,
```

- [ ] **Step 5: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: clean, 231+ tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/generation/orchestrator.ts lib/providers/anthropic/generation.ts lib/providers/openai/generation.ts
git commit -m "Thread kept and rejected titles through the generation pipeline"
```

---

### Task 6: API routes

**Files:**
- Modify: `app/api/generate/route.ts`
- Modify: `app/api/feedback/route.ts`

**Interfaces:**
- Consumes: `sanitizeAvoidTitles`, `prunableIds`, `LIKED_CAP_PER_CREATOR` (Task 2); `embed` from `@/lib/providers/openai/embedding`.
- Produces: `/api/generate` accepts `avoid_titles`; `/api/feedback` indexes likes.

- [ ] **Step 1: Persist `creator_handle` and accept `avoid_titles`**

In `app/api/generate/route.ts`: add `creator_handle: body.creator_handle` to the `generation_attempts` insert, and pass to `runPipeline`:

```ts
    creatorHandle: body.creator_handle,
    avoidTitles: sanitizeAvoidTitles(body.avoid_titles),
```

Import `sanitizeAvoidTitles` from `@/lib/feedback/rules`.

- [ ] **Step 2: Index a like in the feedback route**

After the successful ledger upsert in `app/api/feedback/route.ts`, add — note every field comes from the database, not the client:

```ts
  if (body.vote === 1) {
    // Best-effort. A like that fails to index is a missed voice signal, not a
    // lost vote: the ledger row above already stands, and a thumbs-up must not
    // surface an error.
    try {
      const gen = await db()
        .from('generations')
        .select('vision_description, generated_titles, generation_attempts(creator_handle, niche_id)')
        .eq('id', body.generation_id)
        .single();
      if (gen.error || !gen.data) throw new Error(gen.error?.message ?? 'generation not found');

      const attempt = gen.data.generation_attempts as unknown as {
        creator_handle: string | null;
        niche_id: string;
      };
      const titles = gen.data.generated_titles as Array<{ text: string; hookFamily: string }>;
      const picked = titles[body.title_index];
      const vision = gen.data.vision_description as { scene: string; visualHook: string };
      if (!picked || !attempt?.creator_handle) throw new Error('missing title or creator_handle');

      // MUST match lib/generation/orchestrator.ts byte for byte, or these
      // vectors land in a different space from corpus_titles.description_embedding.
      const text = `${vision.scene} ${vision.visualHook}`.slice(0, 8000);
      const { vector } = await embed(text);

      await db().from('liked_titles').upsert(
        {
          generation_id: body.generation_id,
          title_index: body.title_index,
          creator_handle: attempt.creator_handle,
          niche_id: attempt.niche_id,
          title: picked.text,
          hook_family: picked.hookFamily,
          visual_description: text,
          description_embedding: vector as unknown as string,
        },
        { onConflict: 'generation_id,title_index' },
      );

      const existing = await db()
        .from('liked_titles')
        .select('id, created_at')
        .eq('creator_handle', attempt.creator_handle);
      const victims = prunableIds(existing.data ?? [], LIKED_CAP_PER_CREATOR);
      if (victims.length > 0) await db().from('liked_titles').delete().in('id', victims);
    } catch (e) {
      console.warn(`feedback: like not indexed: ${(e as Error).message}`);
    }
  }
```

Add imports: `embed` from `@/lib/providers/openai/embedding`, and `prunableIds` / `LIKED_CAP_PER_CREATOR` from `@/lib/feedback/rules`.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add app/api/generate/route.ts app/api/feedback/route.ts
git commit -m "Index likes on vote, and accept an avoid list on generate"
```

---

### Task 7: Client wiring

**Files:**
- Modify: `components/app/title-list.tsx`
- Modify: `app/(app)/page.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `TitleList` prop `onDislikedChange?: (titles: string[]) => void`.

- [ ] **Step 1: Report disliked titles upward**

In `components/app/title-list.tsx`, add `onDislikedChange?: (titles: string[]) => void` to `Props`, accept it in the signature, and replace the body of `onVote` so the parent is told the new set. `TitleList` keeps owning its vote state:

```ts
  const onVote = async (i: number, v: -1 | 1) => {
    const next = { ...votes, [i]: v };
    setVotes(next);
    onDislikedChange?.(
      Object.entries(next)
        .filter(([, vote]) => vote === -1)
        .map(([idx]) => titles[Number(idx)]?.text)
        .filter((t): t is string => !!t),
    );
    const r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation_id: generationId, title_index: i, vote: v }),
    });
    if (!r.ok) toast.error(`Feedback failed (${r.status})`);
  };
```

- [ ] **Step 2: Hold the list on the page and send it**

In `app/(app)/page.tsx`, five edits:

```tsx
// 1. beside the other useState calls
const [avoidTitles, setAvoidTitles] = useState<string[]>([]);

// 2. inside reset()
setAvoidTitles([]);

// 3. in the /api/generate request body, after `steering`
avoid_titles: avoidTitles,

// 4. the generate useCallback dependency array
[storagePath, avoidTitles],

// 5. on the <TitleList> element
onDislikedChange={setAvoidTitles}
```

Note edit 4: without `avoidTitles` in the dependency array the callback closes
over a stale empty list and the rejections silently never reach the server.

- [ ] **Step 3: Typecheck and test**

Run: `npm run typecheck && npm test`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/page.tsx" components/app/title-list.tsx
git commit -m "Send rejected titles with the regenerate request"
```

---

### Task 8: Admin review file

**Files:**
- Create: `scripts/lib/feedback-report.ts`
- Test: `scripts/lib/feedback-report.test.ts`
- Create: `scripts/review-feedback.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `renderFeedbackReport(rows: FeedbackRow[], generatedAt: string): string`; npm script `review:feedback`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { renderFeedbackReport, type FeedbackRow } from './feedback-report';

const rows: FeedbackRow[] = [
  {
    creatorHandle: 'henryjwade',
    vote: 1,
    title: 'The coat that does all the work',
    hookFamily: 'transformation_tease',
    visualDescription: 'man in a wool overcoat, city street at dusk',
    generationId: 'gen-1',
    createdAt: '2026-08-09T10:00:00Z',
  },
  {
    creatorHandle: 'henryjwade',
    vote: -1,
    title: 'A guide to autumn outerwear',
    hookFamily: 'listicle_reveal',
    visualDescription: 'man in a wool overcoat, city street at dusk',
    generationId: 'gen-1',
    createdAt: '2026-08-09T10:01:00Z',
  },
];

describe('renderFeedbackReport', () => {
  it('counts both directions in the header', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    expect(out).toContain('1 kept');
    expect(out).toContain('1 rejected');
  });

  it('groups by creator and separates the two directions', () => {
    const out = renderFeedbackReport(rows, '2026-08-09T12:00:00Z');
    expect(out).toContain('## @henryjwade');
    expect(out).toContain('### Kept');
    expect(out).toContain('### Rejected');
  });

  it('shows the visual description each title was generated for', () => {
    expect(renderFeedbackReport(rows, '2026-08-09T12:00:00Z')).toContain(
      'man in a wool overcoat, city street at dusk',
    );
  });

  it('says so plainly when there is nothing to review', () => {
    expect(renderFeedbackReport([], '2026-08-09T12:00:00Z')).toContain('No votes recorded yet');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run scripts/lib/feedback-report.test.ts`
Expected: FAIL — cannot find module `./feedback-report`.

- [ ] **Step 3: Implement the renderer**

```ts
// Pure: rows in, Markdown out. Kept separate from the script that reads
// Postgres so the formatting is testable without a database.

export type FeedbackRow = {
  creatorHandle: string;
  vote: 1 | -1;
  title: string;
  hookFamily: string;
  visualDescription: string;
  generationId: string;
  createdAt: string;
};

function entry(r: FeedbackRow): string {
  return [
    `- **${r.title}**`,
    `  - family: \`${r.hookFamily}\``,
    `  - generated for: ${r.visualDescription}`,
    `  - ${r.createdAt} · generation \`${r.generationId}\``,
  ].join('\n');
}

export function renderFeedbackReport(rows: FeedbackRow[], generatedAt: string): string {
  const kept = rows.filter((r) => r.vote === 1);
  const rejected = rows.filter((r) => r.vote === -1);

  const head = `# Title feedback — generated ${generatedAt}

${kept.length} kept · ${rejected.length} rejected · ${rows.length} total

Every vote a tester has cast, with the visual description each title was
generated for. Kept titles also feed the creator's voice examples; rejected
titles only affected the clip they were rejected on.`;

  if (rows.length === 0) return `${head}\n\nNo votes recorded yet.\n`;

  const creators = [...new Set(rows.map((r) => r.creatorHandle))].sort();
  const sections = creators.map((handle) => {
    const mine = rows.filter((r) => r.creatorHandle === handle);
    const k = mine.filter((r) => r.vote === 1);
    const x = mine.filter((r) => r.vote === -1);
    const parts = [`## @${handle}`];
    if (k.length) parts.push(`### Kept (${k.length})\n\n${k.map(entry).join('\n\n')}`);
    if (x.length) parts.push(`### Rejected (${x.length})\n\n${x.map(entry).join('\n\n')}`);
    return parts.join('\n\n');
  });

  return `${head}\n\n---\n\n${sections.join('\n\n---\n\n')}\n`;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run scripts/lib/feedback-report.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Write the script**

Create `scripts/review-feedback.ts`, following `scripts/verify-retrieval.ts` for env loading and the PostgREST fetch pattern:

```ts
// Human-readable dump of every vote, for admin review.
//
// Run: npm run review:feedback
// Writes: datasets/raw/_title-feedback.md (gitignored, like the rest of raw/)

import fs from 'node:fs';
import path from 'node:path';
import { loadEnvLocal, requireEnv } from './lib/load-env';
import { renderFeedbackReport, type FeedbackRow } from './lib/feedback-report';

const OUT = path.join('datasets', 'raw', '_title-feedback.md');

async function main() {
  loadEnvLocal();
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const select =
    'vote,title_index,created_at,generation_id,' +
    'generations(vision_description,generated_titles,generation_attempts(creator_handle))';
  const res = await fetch(
    `${url}/rest/v1/title_feedback?select=${encodeURIComponent(select)}&order=created_at.desc`,
    { headers: { apikey: key, authorization: `Bearer ${key}` } },
  );
  if (!res.ok) throw new Error(`title_feedback: ${res.status} ${await res.text()}`);

  const raw = (await res.json()) as any[];
  const rows: FeedbackRow[] = raw.flatMap((r) => {
    const gen = r.generations;
    const picked = gen?.generated_titles?.[r.title_index];
    const vision = gen?.vision_description;
    const handle = gen?.generation_attempts?.creator_handle;
    if (!picked || !vision) return [];
    return [{
      creatorHandle: handle ?? '(unattributed)',
      vote: r.vote as 1 | -1,
      title: picked.text,
      hookFamily: picked.hookFamily ?? '(unknown)',
      visualDescription: `${vision.scene} ${vision.visualHook}`,
      generationId: r.generation_id,
      createdAt: r.created_at,
    }];
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, renderFeedbackReport(rows, new Date().toISOString()), 'utf8');
  console.log(`wrote ${rows.length} votes to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Rows whose generation was deleted are skipped rather than rendered half-empty — `title_feedback` cascades on generation delete, so this is belt-and-braces.

- [ ] **Step 6: Add the npm script**

In `package.json` scripts, after `"verify:retrieval"`:

```json
    "review:feedback": "tsx scripts/review-feedback.ts",
```

- [ ] **Step 7: Run it end to end**

Run: `npm run review:feedback`
Expected: writes `datasets/raw/_title-feedback.md`. With no votes yet it reports "No votes recorded yet."

- [ ] **Step 8: Commit**

```bash
npm run typecheck && npm test
git add scripts/lib/feedback-report.ts scripts/lib/feedback-report.test.ts scripts/review-feedback.ts package.json
git commit -m "Add the admin feedback review report"
```

---

## Manual verification

Requires the Anthropic spend cap to be lifted — generation is currently blocked
by a Console usage limit (`400 invalid_request_error`, resets 2026-09-01).

1. Upload a clip, generate, thumbs-down two titles, press regenerate. The two
   rejected lines should not reappear.
2. Thumbs-up one title. Confirm a row lands in `liked_titles` with a non-null
   `description_embedding`.
3. Upload a *visually similar* clip and generate. The kept title should appear
   in the prompt's "Titles this creator kept" block.
4. Upload a visually *unrelated* clip. It should not appear — that is the
   similarity floor doing its job.
5. Run `npm run review:feedback` and read the file.
