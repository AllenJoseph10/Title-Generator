# Session handoff — updated 2026-08-03

Dataset-extraction work for the silent-video title generator. Read this first; it is the entry point to everything else.

---

## What the project is

A Next.js app: upload a silent short-form video → get 10 ranked burned-in title ideas in a creator's voice. Pipeline is `upload → ffmpeg frames → vision description → embed → pgvector retrieval → generate → prior score`.

Subject creator is **`henryjwade`** on Instagram (the builder brief anonymises him as "William Wade" / `william_j_wade`; scraped data uses the real handle).

The corpus previously held 250 hand-invented seed titles with guessed save rates. This work replaced that with real scraped data.

---

## Current state: the dataset is complete

**`datasets/william-wade-titles.csv` — 175 rows, 22 columns, committed.**

| | |
|---|---|
| Verbatim burned-in titles | **175 / 175** |
| Visual descriptions | **175 / 175** |
| Share counts | **172 / 175** (3 genuine nulls, see below) |
| views / likes / comments | corrected **and** independently audited |
| `performance_score` | **172 / 175** |
| Malformed rows | **0** |

93 rows from `henryjwade`, 82 from 12 B-roll creators. `saves` and `hook_family` permanently empty.

**Spend:** ~$11.52 Anthropic (of ~$20). SocialCrawl: ~1,489 of 2,511 credits used, **~1,022 remaining** (£15 tier).

**Branch `feat/dataset-extraction`** — ~35 commits, 97 tests, typecheck clean, tree clean. **NOT PUSHED.** The brief requires pushing and messaging Allen. Still outstanding.

---

## Performance metric — DECIDED

Full reasoning: **`docs/findings/2026-08-02-performance-metric-decision.md`**

- **Primary: `performance_score`** = percentile rank of `share_rate` (`shares/views`), 0–1
- **Secondary: `view_outlier_score`** = percentile rank of `views / creator median`
- Raw `share_rate` and `view_outlier` also emitted, so scores can be re-derived without a re-scrape

Share rate is the engagement behaviour most attributable to the *title* (a like reacts to the video; forwarding it is triggered by the line), and it is causally upstream of reach. 33× spread, and its median *rises* with views so it does not reward low-reach videos. View outlier is kept because at **0.410** correlation it is the most independent signal available — the eval can then measure which actually predicts.

**Rejected:** full engagement `(l+c+s)/v` correlates **0.960** with plain engagement rate — likes swamp shares, laundering the best signal into the weakest.

### Consequences for the importer

1. **3 rows have no `performance_score`** — treat as **unscored, NOT zero**. A zero ranks genuinely-unmeasured videos at the bottom and teaches the model those titles failed. `merge-dataset.ts` warns with the count.
2. An empty `shares` cell means *no reading*, never zero.
3. `performance_score` populates the column currently named `corpus_titles.save_rate_estimate` — **which must be renamed**; it will not hold a save rate.
4. **Percentiles are corpus-relative.** Appending rows later invalidates every existing score — recompute, never append rows carrying stale percentiles.

---

## How extraction works

Each video is read **once** by `claude-sonnet-4-6` over 8–12 frames spread across the clip. Hook titles are separated from speech captions by **behaviour across frames** (a title is identical in every frame; captions change constantly), never by screen position.

A **second, offset-sampled read** runs only when pass 1's evidence is weak (`uncertain`, ≤2 frames, captions with patchy coverage) or when acting alone would discard a row (`multi_title_claim`, `no_title_claim`). Conflicts are quarantined, never guessed.

Descriptions reuse `lib/providers/anthropic/vision.ts` **unchanged** at exactly 8 frames with no options — reproducing the app's runtime call byte-for-byte, including its 16-second coverage limit. Retrieval compares corpus descriptions against the description the app generates at upload time, so both sides must come from the same prompt, model and sampling. **22% of videos exceed 16s** and are described from their opening only.

**Stage A results (108 new videos):** 74 included (69%), 20 no-title (19%), 7 disagreement, 4 multi-title, 3 single-frame. Escalation fired on 37%, but **genuine model uncertainty was 1 video in 108**.

**henryjwade recheck: 20/20 titles matched exactly.** No re-run needed.

**8 rows were promoted by human review** (brief title cards the single-frame rule had quarantined), each carrying a `humanReview` field with its reason.

---

## Two defects found and fixed

### 1. The views column mixed two metrics

`docs/findings/2026-08-02-view-metric-inconsistency.md`

`scrape-instagram.ts` preferred `videoViewCount` over `videoPlayCount`. Instagram returns **both**; they disagree by **2.6×–130×**. ~88% of stored views were 2–3× too low with nothing marking which rows.

Fixed at source (`926c72e`) and repaired across 1,828 rows (`f10f412`, `scripts/refresh-metrics.ts --apply`). All manifests backed up first. **Independently verified** against SocialCrawl: 562,527 vs 562,525 on a known row.

**This invalidated an earlier metric analysis done on the corrupt column** — that analysis was discarded and redone.

### 2. Bulk share collection was the wrong tool

`/profile/reels/full` performs an internal per-reel shares fanout (~17s per 10-item page). Target rows sit deep in each profile, so paging burned ~690 credits, hit repeated 504s, and filled no rows. Replaced by `scripts/collect-shares-direct.ts`, which looks each post up individually via `/instagram/post/stats` (5 credits flat). Filled 62 of 64 remaining rows, zero failures.

---

## Metrics availability (tested, not assumed)

| metric | Apify | SocialCrawl |
|---|---|---|
| views | ✅ `videoPlayCount` | ✅ agrees to 0.002% |
| likes / comments | ✅ | ✅ |
| **shares** | ❌ | ✅ |
| **reposts** | ❌ | ❌ |
| **saves** | ❌ | ❌ (`null` on every reel, incl. premium) |

The brief's claim that `saves` is "the most valuable column" is **obsolete** — Instagram hides the feature and no source supplies it. `datasets/README.md` corrected (`371fcf4`).

**Cross-source audit (111 rows, both sources):** views 109/111 within 2% (Spearman **0.9990**), likes **111/111**, comments **111/111**. The Apify repair is verified, not merely believed.

**SocialCrawl gotcha:** `credits_remaining` reports **0 on cached responses**. Only trust it when `cached === false`. This nearly caused a false "out of credits" panic twice.

---

## OPEN ITEMS

1. **Push the branch** and message Allen.
2. **175 rows vs the 200 floor.** Cause: 19% of B-roll had no burned-in title at all (spec assumed ~2%). Needs ~30 more scraped videos. `datasets/raw/_metrics-refresh-report.md` lists 161 already-scraped rejects that would now pass the corrected gate (~$15 of OCR + descriptions to add).
3. **Known bug:** `scripts/refresh-metrics.ts` applies the *outliers* gate to `henryjwade`, who was scraped in *top-bottom* mode. Its 3 "new candidates" for him are mid-pack, not top-50 — **not recommended for addition**. Fix before trusting that section again.

## REMAINING WORK (deliverables 2–5)

- **Schema + retrieval** — `supabase/migrations/0003_descriptions.sql`, rebuild `match_corpus_titles`, point `search.ts`/MMR at `description_embedding`. Deferred deliberately: applying early empties retrieval for no benefit. **Needs TWO embedding columns** — retrieval needs description-space, `computeTitlePrior` needs title-space; one vector cannot serve both.
- **`scripts/import-dataset.mjs`** (deliverable 2) — note `lib/hooks/classify.ts` returns ≥3 *candidate* families from a vision description; it is NOT a single-label title classifier. That gap must be filled.
- **`scripts/eval.mjs` + `EVAL.md`** (deliverable 4) — the experiment to run is whether `performance_score` or `view_outlier_score` better predicts held-out performance. They agree only moderately (0.410), so they will disagree on a meaningful fraction of rows.
- **Niche selector** (deliverable 5, stretch) — `page.tsx` hardcodes `luxury-menswear` / `william_j_wade`.

## Why retrieval was broken (and what fixes it)

`orchestrator.ts` embeds `scene + visualHook` and matches it against `corpus_titles.embedding`, which is the embedding of the **title**. Comparing a scene description to a hook title in embedding space is close to noise — retrieval was only weakly better than random. The `visual_description` column exists to enable description↔description matching, which is the comparison the pipeline was always meant to make.

---

## Other records

- `.superpowers/sdd/2026-07-31-burn-in-title-ocr/progress.md` — full decision ledger, every deferred finding with its ruling
- `docs/superpowers/specs/` and `plans/` — design and implementation plan
- `datasets/raw/_shares-audit.md` — cross-source audit
- `datasets/raw/_metrics-refresh-report.md` — per-creator selection analysis
- `datasets/raw/_quarantine-review.md` — quarantined videos with both passes' evidence

**Security:** the builder brief `.docx` files in the repo root contain live client credentials. `*.docx` is gitignored — do not remove it. `SOCIALCRAWL_API_KEY` was added to `.env.local` (also gitignored).
