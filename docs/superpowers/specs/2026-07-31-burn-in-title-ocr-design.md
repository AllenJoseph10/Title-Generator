# Burned-in Title Extraction & Visual Description — Design

**Date:** 2026-07-31
**Status:** Approved design, ready for implementation planning
**Scope:** Stage 2 (OCR) and Stage 2b (description) of the dataset pipeline, plus the schema and retrieval changes descriptions require.

**Revision (2026-07-31):** originally specified two verification passes on every video. Revised to a single pass with escalation on ambiguity, after the project owner confirmed that burned-in titles in this corpus are **static text, not animated**. See §4a for the reasoning and what changed.

---

## 1. Problem

The corpus needs one row per video containing:

- the **burned-in hook title** — the static text overlay the creator added, transcribed verbatim
- a **visual description** of the video, so titles can be retrieved by what the video *shows*

Two hard constraints from the project owner:

1. Training data must contain **only videos with a single burned-in hook title**. A video whose hook title changes partway through is discarded — it does not fit the product concept.
2. Speech captions (auto-generated subtitles) and incidental scene text must **never** be captured as a title.

A contaminated row is worse than a lost row. The pipeline is tuned to discard on doubt.

### Current state

`scripts/extract-burned-in-titles.ts` already performs single-pass OCR via Claude vision and has processed 93 videos for `henryjwade`. 108 videos across 13 B-roll creators are downloaded and awaiting OCR (`status: "scraped"`).

Four defects in the existing implementation motivate this redesign:

1. **The prompt is tuned to keep borderline videos.** It instructs the model to "be conservative about `additionalTitles`" — i.e. under-report multi-title videos. That is the opposite of the stated requirement.
2. **Nothing verifies the answer, and nothing is auditable.** One call, one self-reported verdict, no evidence, no confidence. A paraphrased, case-normalised, or emoji-stripped title passes silently — and verbatim phrasing is precisely what the corpus exists to teach.
3. **The tool description contradicts the system prompt.** It states frames are "top-half-cropped"; the crop default is `undefined` (no crop), and the system prompt explicitly says position is not a reliable signal.
4. **Frame count scales with duration for no benefit.** A 60s clip costs twice a 30s clip. Once a static title has been observed across ~10 evenly-spread frames, further frames add nothing.

### The retrieval defect that descriptions fix

`lib/generation/orchestrator.ts` embeds `` `${description.scene} ${description.visualHook}` `` as the retrieval query, and `match_corpus_titles` matches that vector against `corpus_titles.embedding` — which is the embedding of the **title text**.

The system therefore compares a scene description against a hook title in embedding space. These are different registers of language occupying different regions; the resulting cosine similarity is close to noise. Retrieval is currently only weakly better than random.

Storing a description per corpus row enables **description ↔ description** matching, which is the comparison the pipeline was always meant to make.

---

## 2. Goals

- Extract exactly one verbatim hook title per qualifying video, or discard the video.
- Never emit a speech caption or scene text as a title.
- Discard every multi-title video.
- Capture a short visual description per included video, in the same vocabulary the app produces at runtime.
- Keep every stage independently resumable and crash-safe.
- Produce an auditable trail: every decision, and the evidence for it, recorded in the manifest.
- Spend verification budget only where the evidence is genuinely ambiguous.

## 3. Non-goals

- Changing `lib/generation/orchestrator.ts`. The retrieval call signature is unchanged.
- Changing `lib/retrieval/prior.ts` or `computeTitlePrior`. The prior's title↔title comparison is already correct.
- Building the CSV importer or eval harness (separate deliverables).
- Achieving 100% automated accuracy. Ambiguous videos are routed to human review, not guessed.

---

## 4. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **One OCR pass by default**, escalating to a second pass only on ambiguous evidence | Static titles make the persistence signal unambiguous on most videos; blanket double-reading pays for certainty already in hand |
| D2 | **Fixed 10–12 frames spread evenly across the whole clip**, not one per 2s | Constant cost per video with full coverage; the old scheme paid double for 60s clips with no gain |
| D3 | The escalation pass uses an **offset frame sample** so it sees different frames | Re-reading identical frames would reproduce the same misreading and never disagree |
| D4 | Agreement (when escalated) = **normalised exact match**; stored string is pass 1's **raw** text | Ignores casing/punctuation noise without sacrificing verbatim fidelity |
| D5 | A multi-title claim is **escalated before discarding**, not acted on immediately | A false positive here silently costs a corpus row; confirmation is cheap |
| D6 | Progressive/animated title reveal → **keep**, flagged `partialReveal` for spot-check | Same sentence building up is one title. Rare in this corpus, but the branch is retained as a safety net |
| D7 | Descriptions come from the **existing vision provider, unchanged** | Corpus descriptions must match runtime queries in vocabulary or embedding similarity degrades |
| D8 | Descriptions are **single-pass, unverified** | Fuzzy free text consumed only by an embedding model; no exact-match requirement |
| D9 | **Two embedding columns**: `embedding` (title) + `description_embedding` | Retrieval needs description-space; the prior needs title-space; one vector cannot serve both |
| D10 | Model stays **`claude-sonnet-4-6`** | No mid-project model change; avoids the Sonnet 5 adaptive-thinking/`max_tokens` interaction; ~$2 difference |
| D11 | **Full batch run**, reviewed via an end-of-run report | Fastest wall-clock; the quarantine bucket makes a mid-run checkpoint unnecessary |
| D12 | henryjwade's existing 93 rows: **20-video spot-check** with a fixed decision rule | Cheapest way to learn whether a full re-run is warranted |

### 4a. Why one pass, not two

The original design ran every video twice on different frames and quarantined on disagreement. That was sized against a specific worry: a full-sentence speech caption held on screen for 3–4 seconds can look identical across two *adjacent* frames and mimic a static title.

The project owner has since confirmed these titles are **static text, not animated**. That makes the discriminator far stronger than assumed:

- A static hook title appears in **most or all** sampled frames — typically 9 or 10 of 10.
- A speech caption line appears in **1 or 2** frames, because it is replaced as speech moves on.

That is a ~10:1 separation, not a marginal call. The two-frame collision that motivated blanket verification cannot survive contact with ten frames spread across the whole clip. Paying to re-read the ~75% of videos where the evidence is that clear buys nothing.

Verification is therefore retained precisely where evidence is weak or where a wrong call is expensive — see §5.4. Cost drops from ~$19 to ~$11 with no loss of protection on the cases that matter.

**Accepted trade-off:** a confident, quiet error on an easy video will not be caught automatically. The manual audit in §10 is the backstop.

---

## 5. Architecture

```
Stage 1   scrape-instagram.ts        (built)  → status: scraped
Stage 2   extract-burned-in-titles   (rework) → included | needs_review_* | excluded_*
Stage 2b  describe-videos            (new)    → visualDescription on included rows
Stage 6   merge-dataset              (new)    → datasets/william-wade-titles.csv
```

Each stage reads and writes `datasets/raw/<handle>/manifest.json`, writing after **every** video so a crash loses at most one video's work. Re-running a stage processes only rows not yet in that stage's terminal state.

Stage 2b runs after Stage 2 so descriptions are only paid for on videos that survived OCR.

### 5.1 Frame sampling

Frames are sampled **evenly across the full clip duration**, at a fixed count:

```
frameCount = clamp(ceil(durationSec / 5), 10, 12)
```

The upper bound binds only at the pipeline's 60s duration cap; anything shorter takes the floor of 10.

| Clip length | Frames | Spacing |
|---|---|---|
| 20s | 10 | every 2.0s |
| 30s | 10 | every 3.0s |
| 45s | 10 | every 4.5s |
| 60s | 12 | every 5.0s |

This replaces `fps=1/2` with `fps=<frameCount>/<durationSec>`, so coverage always spans the whole clip and cost is roughly constant per video regardless of length. Ten frames is ample to establish persistence of static text, and remains dense enough to catch a second title in a multi-clip video — segments in this corpus run several seconds, so a distinct title occupies at least one sampled frame.

Frames remain 720×1280. `claude-sonnet-4-6` caps vision at 1568px on the long edge; 1280 is under that, so no server-side downscaling occurs.

`extractFrames` gains an `offsetSec` option that inserts `-ss <offset>` **before** `-i` (input seeking). The escalation pass (§5.4) uses `offset = spacing / 2`, placing its frames exactly between pass 1's — so the two passes share no frames and can genuinely disagree.

**Edge case:** if a pass yields fewer than 2 frames (clips under ~4s), the video is routed to `needs_review_too_short` rather than judged — two frames is the floor for establishing persistence.

### 5.2 Tool contract

`transcribe_title` gains evidence fields. Under a single-pass default these are load-bearing, not decorative: they are what the escalation rule reads.

```ts
{
  primaryTitle:     string,
  additionalTitles: string[],
  noTextFound:      boolean,
  framesWithTitle:  number[],   // 0-indexed frames the hook title was visible in
  totalFrames:      number,
  captionsPresent:  boolean,    // were speech captions visible at all
  partialReveal:    boolean,    // title animated/built up rather than appearing whole
  uncertain:        boolean     // model cannot confidently classify what it saw
}
```

The stale `(top-half-cropped)` phrasing is removed from the tool description.

`titleFrameRatio = framesWithTitle.length / totalFrames` is derived and stored on every row.

**On thresholds:** `titleFrameRatio` is deliberately not used as a high acceptance bar. Some legitimate hook titles are shown only for the first few seconds and then dropped, which at 10-frame sampling is 1–2 frames; an 80%-coverage rule would systematically discard exactly those. It is used only to *trigger review*, never to silently reject.

### 5.3 Prompt changes

`lib/prompts/burned-in-title.ts` retains its core mechanism — distinguishing hook titles from captions and scene text by **behaviour across frames** rather than by screen position — which is correct and stays. Four edits:

1. **Invert the conservatism.** Replace "Be conservative about `additionalTitles`" with: when genuinely unsure whether persistent text is a hook title or a slow caption, set `uncertain: true` rather than guessing either way.
2. **Add verbatim fidelity.** Transcribe exactly as shown — original casing, punctuation, emoji, and any typos. Do not correct, normalise, or translate.
3. **Add the partial-reveal rule.** A single sentence progressively revealed or animated in is **one** title: report the fullest version seen and set `partialReveal: true`. A genuinely different complete message later in the clip is `additionalTitles`.
4. **Add evidence-field definitions** for `framesWithTitle`, `captionsPresent`, and `uncertain`.

### 5.4 Escalation rule

Pass 1 runs on every video. A second pass runs **only** when pass 1's own evidence is weak, or when acting on pass 1 alone would be expensive to get wrong:

| Trigger | Why |
|---|---|
| `uncertain === true` | The model itself declined to commit |
| `framesWithTitle.length <= 2` | Persistence not established |
| `captionsPresent && titleFrameRatio < 0.6` | The exact caption/title confusion case |
| `additionalTitles` non-empty | Confirm before discarding — a false positive costs a row (D5) |
| `noTextFound === true` | Confirm before discarding — guards a faint or short-lived title. Rare (~2% observed), so near-free |

Everything else — a title seen in most frames, no uncertainty, no competing title — is accepted on one pass.

Expected escalation rate: **15–25%**.

### 5.5 Agreement check (escalated rows only)

```
normalise(s) = lowercase → strip punctuation and emoji → collapse whitespace → trim

agree  = normalise(pass1.primaryTitle) === normalise(pass2.primaryTitle)
stored = pass1.primaryTitle                    // raw, verbatim, unmodified
```

Normalisation is used **only** for the comparison. What is written to the manifest and CSV is always the raw string, so verbatim fidelity survives.

### 5.6 Status model

| Status | Rule |
|---|---|
| `included` | Pass 1 unambiguous (no escalation trigger), **or** escalated and both passes agree on the same single title |
| `excluded_multi_title` | Pass 1 reported extra titles **and** pass 2 confirmed them |
| `excluded_no_title` | Pass 1 reported no title **and** pass 2 confirmed |
| `needs_review_disagreement` | Escalation ran and the two passes conflict — including "pass 1 said multi, pass 2 said single" and "one found a title, the other didn't" |
| `needs_review_uncertain` | Both passes set `uncertain: true` |
| `needs_review_single_frame` | Passes agree on a title, but it appeared in ≤1 frame in both |
| `needs_review_too_short` | Fewer than 2 frames extractable |

Flags stored on `included` rows for spot-checking: `partialReveal`, `captionsPresent`, `titleFrameRatio`, `escalated`.

Every pass's full raw response is stored on every row regardless of outcome, so any decision can be re-audited without re-running the model.

**Row selection.** By default Stage 2 reads only rows with `status: "scraped"`, so a normal re-run never disturbs completed work. The henryjwade spot-check (§8) needs to re-process rows that are already `included`, so the script takes an explicit `--recheck <n>` flag that selects an already-processed sample instead. In `--recheck` mode the script **reports** differences and does not write status changes — re-running the full set is a separate, deliberate invocation.

Existing statuses from Stage 1 (`scraped`, `excluded_duration`, `excluded_window`, `excluded_duplicate`, `excluded_low_views`, `excluded_rank`, `excluded_no_video`) are untouched.

### 5.7 Description stage

A new script, `scripts/describe-videos.ts`, that for each `included` row:

1. extracts **8** frames (matching `TARGET_FRAMES` in the orchestrator, so corpus rows are described at the same frame density as runtime queries)
2. calls `anthropicVision.describe({ kind: 'frames', jpegs })` — the existing provider, unchanged, using the existing `VISION_SYSTEM_PROMPT`
3. stores all five returned fields (`scene`, `subject`, `setting`, `vibe`, `visualHook`) in the manifest
4. derives the flattened description used for embedding:

```ts
visualDescription = `${scene} ${visualHook}`;
```

which is byte-for-byte the same concatenation `orchestrator.ts` uses to build `queryText`.

Reusing the provider verbatim is load-bearing, not a convenience. Embedding similarity is only meaningful when both sides are drawn from the same distribution. A bespoke description prompt would describe the same video in different vocabulary than the runtime query, reintroducing a milder version of the exact mismatch this change exists to fix.

A description failure records a `describeError` field and does **not** change status — a failed description must never discard a good title. Re-running the stage retries only rows with a title and no description.

---

## 6. Schema changes

New migration `supabase/migrations/0003_descriptions.sql`, idempotent in the style of the existing migrations.

```sql
alter table corpus_titles add column if not exists visual_description    text;
alter table corpus_titles add column if not exists description_embedding extensions.vector(1536);
```

### 6.1 Retrieval RPC

`match_corpus_titles` must return an additional column. Postgres does not permit `create or replace function` to change a `RETURNS TABLE` shape, so the migration must:

1. `drop function if exists match_corpus_titles(text, extensions.vector(1536), int);`
2. recreate it ordering by `description_embedding <=> p_query_embed`, filtering `where description_embedding is not null`, and returning **both** `embedding` and `description_embedding`
3. re-issue `grant execute ... to service_role`

Omitting the drop produces a confusing runtime error rather than a migration-time failure.

### 6.2 Consumers

- **`lib/retrieval/search.ts`** — relevance is computed from `description_embedding`.
- **`lib/retrieval/mmr.ts` usage** — MMR redundancy also uses `description_embedding`. Drawing relevance from one vector space and redundancy from another makes the λ blend mathematically incoherent; both sides must use the same space.
- **`lib/retrieval/prior.ts`** — unchanged. `RetrievedRow.embedding` continues to carry the **title** vector, so `computeTitlePrior` keeps comparing generated titles against corpus titles.

### 6.3 Known consequence

Once the RPC filters on `description_embedding is not null`, the **250 hand-written seed rows drop out of retrieval permanently**. They have no source video, so they can never acquire a description.

This is judged acceptable and probably beneficial — those rows carry invented `save_rate_estimate` values and were polluting retrieval. But between applying the migration and importing real data, retrieval returns zero rows for every niche. The app degrades gracefully: `orchestrator.ts` already handles `retrieval.neighbors.length === 0` and falls every prior back to `0.5`. Titles are still generated, without retrieved examples.

**Mitigation:** sequence this migration close to the data import rather than applying it early.

---

## 7. CSV output

`visual_description` is appended as the **17th** column, after `notes`. Appending rather than inserting keeps the column order documented in `datasets/README.md` valid; the importer reads by header name regardless.

Full header:

```
video_id,date_posted,platform,creator_handle,video_url,burned_in_title,caption,
views,likes,comments,shares,saves,duration_sec,niche,hook_family,notes,visual_description
```

`shares` and `saves` remain empty — private analytics, unscrapable. `hook_family` remains empty — assigned by the importer via `lib/hooks/taxonomy.ts`.

`datasets/README.md` is updated in the same commit to document the new column **and** to fix its stale hook-family list, which currently names five families (`visceral_specificity`, `contrarian_truth`, `mystery_loop`, `asymmetry_insight`, `status_aspiration`) that do not exist in `lib/hooks/taxonomy.ts` or the `hook_families` table and would fail the foreign key on insert.

---

## 8. The henryjwade spot-check

The existing 93 rows were produced under the old single-pass, conservative-prompt logic with no evidence fields. Rather than re-running all of them blind:

1. Select 20 of the 93 (deterministic sample — every 4th `included` row by manifest order, so it is reproducible).
2. Run them through the new pipeline via `--recheck 20`, which reports without mutating status (§5.6).
3. Compare each result against the stored title using the same `normalise` function.

**Decision rule, fixed in advance:**

> If **≥2 of 20 (10%)** disagree with the stored title or change status → re-run all 93.
> If **0–1** → keep the existing 93 as-is.

Cost: ~$1.

---

## 9. Cost and credentials

### 9.1 Estimate

`claude-sonnet-4-6` at $3.00/MTok input, $15.00/MTok output. 720×1280 frames ≈ 1,230 image tokens each; ~10–12 frames plus prompt ≈ 14K input tokens per OCR call.

| Item | Estimate |
|---|---|
| OCR pass 1 — 108 B-roll videos | ~$4.50 |
| OCR escalation — ~20% of them | ~$0.90 |
| Descriptions — ~90 included videos × 8 frames | ~$2.90 |
| henryjwade spot-check — 20 videos | ~$1.00 |
| Output tokens (512 cap × ~230 calls) | ~$1.70 |
| Embeddings (`text-embedding-3-small`, ~200 descriptions) | <$0.01 |
| **Total** | **≈ $11** |

A full henryjwade re-run, if the spot-check triggers one, adds ~$4.50.

### 9.2 Which key pays

The scripts call `api.anthropic.com` directly using `ANTHROPIC_API_KEY` from `.env.local`. **That key's owner is billed** — this is unrelated to any Claude Code session used to develop the scripts.

The key currently in `.env.local` was supplied in the builder brief and belongs to the **client**, who states it will be rotated once the project ends. Two implications:

- The run above bills to the client unless the key is swapped.
- Any re-run after project handover will fail once the key is rotated. If long-term re-runnability matters, substitute an own-account key — a one-line change in `.env.local`, no code impact.

---

## 10. Verification

The stage is complete when:

1. `npm run typecheck` and `npm run build` both pass.
2. The end-of-run report prints counts per status, the escalation rate, and lists every `needs_review_*` row with each pass's answer.
3. A manual audit of **10 `included` rows** confirms each stored title matches the video's on-screen text verbatim, and none is a speech caption. Under a single-pass default this is the primary defence against a confident quiet error — it is not optional.
4. A manual audit of **all `needs_review_disagreement` rows** confirms the disagreements are genuine ambiguity rather than a prompt defect.
5. A manual audit of **5 `excluded_multi_title` rows** confirms they genuinely contain more than one hook title — this is the discard path, so a false positive here silently costs corpus rows.
6. **The escalation rate is within 10–35%.** Far below suggests the triggers are not firing and the evidence fields are not being populated honestly; far above suggests the prompt is under-confident and should be tuned before trusting the batch.
7. Spot-checking 5 `visual_description` values confirms they read as plausible descriptions of their videos and are in the same register as `VISION_SYSTEM_PROMPT` output.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| A confident, quiet single-pass error is never caught | Accepted trade-off of D1. The §10.3 manual audit of 10 included rows is the backstop; static titles make this class of error unlikely. |
| Evidence fields are reported carelessly, so escalation never fires | §10.6 makes the escalation rate an explicit acceptance check rather than an incidental statistic. |
| Both passes make the *same* mistake on an escalated row | Offset frame sampling (D3) means they never see the same frames, making correlated error unlikely but not impossible. |
| 10 frames misses a second title in a long clip | Segments in this corpus run several seconds; at 5s spacing a distinct title occupies at least one frame. Multi-title claims are also escalated (D5), which re-samples at a different offset. |
| Descriptions drift in vocabulary from runtime queries | Provider and prompt reused unchanged (D7); frame count matches `TARGET_FRAMES`. |
| Migration applied too early empties retrieval | §6.3 — sequence the migration close to the import. |
| Corpus lands under the 200-row floor after discards | Known and accepted. 93 + ~90 ≈ 183 expected. Raising the count means scraping more creators, which is a Stage 1 concern outside this design. |

---

## 12. Out of scope

- `scripts/import-dataset.mjs` (deliverable 2)
- `scripts/eval.mjs` and `EVAL.md` (deliverable 4)
- Niche selector UI (deliverable 5)
- The `save_rate` substitute-metric decision, which blocks the importer and eval but not this stage
- Additional Stage 1 scraping to raise the row count
