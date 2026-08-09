# Session handoff — updated 2026-08-09

Entry point to the silent-video title generator. Read this first, then `EVAL.md`.

Everything below the "Current state" section is *why things are the way they
are* — decisions, defects and corrections that are still load-bearing. Do not
delete them without reading them; several exist because an earlier version of
this project believed the opposite.

---

## What the project is

A Next.js app: upload a silent short-form video → get burned-in title ideas in
a creator's voice. Pipeline:

```
upload → ffmpeg frames → vision description → embed
      → pgvector retrieval → generate 10 → prior score → display best 5
```

Subject creator is **`henryjwade`** on Instagram. The builder brief anonymises
him as "William Wade" / `william_j_wade`; scraped data uses the real handle.

---

## Current state — 2026-08-09

**The corpus-backfill and eval work is merged.** PR #4
(`feat/corpus-backfill-and-eval-baseline`) landed on `main` at `ae9492c`.
`feature/UI-Initial` was cut from that merge and carries the landing-page and
dashboard rebuild. Current working branch is **`feauture/likes`** (sic — the
typo is in the branch name), which adds the title feedback loop.

**The thumbs up/down buttons are now load-bearing.** They used to write to
`title_feedback` and nothing read it. A dislike now reshapes the next
regenerate for the clip on screen; a like is embedded and retrieved as a voice
signal for that creator on later videos. Design and rationale:
`docs/superpowers/specs/2026-08-09-title-feedback-loop-design.md`.

- Liked titles live in their own `liked_titles` table and **never** enter
  `corpus_titles` — see "Performance metric" below for why that matters.
- Migration `0004_title_feedback.sql` is **applied** (by hand, as always).
- `npm run review:feedback` → `datasets/raw/_title-feedback.md`, a human-readable
  dump of every vote with the visual description it was generated for.
- Verified 2026-08-09: `npm test` → **256 tests across 19 files**; typecheck clean.

**There is no way to measure whether this helps.** The eval scores real corpus
rows with known share rates; it cannot score generated titles. This shipped as
a judgement call, and the review file is what makes that judgement possible
from real votes. The 0.261 baseline is untouched.

**Corpus: 259 rows, 14 creators** — `datasets/william-wade-titles.csv`, imported
into `corpus_titles`.

| | |
|---|---|
| Rows | **259** (was 175 before the 2026-08-07 backfill) |
| Creators | **14** |
| From `henryjwade` | **100** |
| Verbatim burned-in titles | 259 / 259 |
| Visual descriptions | 259 / 259 |
| `performance_score` | **253 / 259** — 6 genuine nulls, unmeasured, **never zero** |
| `saves` | permanently empty — see "Metrics availability" |

**Verified 2026-08-08:** `npm test` → **231 tests passing across 17 files**;
`npm run typecheck` → clean.

**Eval baseline: Spearman 0.261** (5-fold × 25 repeats, seed 20260804, n=253).
Shuffled null −0.001. Slate precision@5 = 0.578 against a 0.500 random
baseline. The full reference run, its uncertainty analysis and its caveats live
in **`EVAL.md` → "THE BASELINE"**. Do not quote a single-seed figure as the
result.

**The backfill did not move the headline, and the doc says so.** It read ~0.26
on 175 rows and ~0.25 on 259. What it *did* buy: `listicle_reveal` finally
clears the n=10 floor (n=17) so all five families report; the corpus now spans
the real performance range instead of winners only, which is what makes the
contrast block in `lib/retrieval/contrast.ts` possible at all.

---

## OPEN ITEMS

**Item 1 is deferred by decision (2026-08-09).** The top *live* item is item 2,
views verification.

### 1. The hook taxonomy does not match the corpus — DEFERRED 2026-08-09

**Status: parked deliberately, to be picked up later.** The analysis below is
kept intact so it does not have to be rediscovered. Nothing downstream is
blocked on it — the prior already ignores `hook_family`
(`FAMILY_PRIOR_BLEND = 0`), so the cost of deferring is that the few-shot labels
and the required-families constraint keep running on categories that do not fit.
That is a quality drag on generation, not a correctness bug.

The five families in `lib/hooks/taxonomy.ts` were designed before any real data
existed. Measured against the real 259 titles (`npx tsx scripts/audit-taxonomy.ts`,
re-run 2026-08-08, zero API cost):

```
titles clustered: 259
  k=5   ARI 0.032   purity 0.386        shuffled-label floor: ARI -0.007
  k=5 clusters: transformation_tease dominates TWO of them, setup_trivial_reveal
                dominates TWO more; best cluster purity is 45%
  low-confidence labels at import: 142 / 259  (55%)
  agreement with the cluster's dominant family:
      high-confidence 40%   vs   low-confidence 37%
```

Three things to read out of that:

- **ARI 0.032 against a −0.007 floor is chance agreement.** The families do not
  describe how these titles actually group.
- **The clusters are not five distinct things.** Two families each win two
  clusters, so the taxonomy is simultaneously too coarse in places and
  duplicative in others.
- **The confidence flag is nearly worthless.** High-confidence labels agree with
  the data's own structure 40% of the time versus 37% for low-confidence — a
  3-point gap. The classifier is not "unsure on the hard ones"; it is guessing
  fairly uniformly, because it is being asked to pick from categories that do
  not fit.

**Blast radius.** `hook_family` feeds three places: the few-shot example labels
in `lib/prompts/generate.ts`, the required-families constraint derived from
retrieved neighbours (`familiesFromNeighbours`), and the family term in
`computeTitlePrior`. The third is already neutralised — `FAMILY_PRIOR_BLEND`
was set to 0 on eval evidence. The first two still consume the labels.

**Do not just re-label into the same five buckets.** The right shape of fix is
open; see "Revisiting the taxonomy" below for the options and how to decide
between them.

### 2. Views were never verified against the Instagram UI

Still open, and still the highest-stakes unknown in the data. Views are the
denominator of `share_rate` and therefore of `performance_score`, the ground
truth the eval measures against. Likes are known to be ~21% low and comments
~48% low versus what the app displays (see the 2026-08-03 correction below). If
views carry a similar error, every score inherits it.

**Spot-check views on 2–3 reels against the Instagram UI.** This is cheap and it
decides whether the primary metric is sound.

### 3. The 69-creator shortlist costs more than the remaining budget

`datasets/creator-shortlist.md` lists 69 deduplicated handles for the next
expansion. Its own "Before scraping these" section is the binding constraint:

- ~**45% of scraped videos yield nothing usable** (137 videos → 76 rows on the
  2026-08-07 backfill).
- **295 remaining SocialCrawl credits cover about 59 videos** — roughly one
  creator's worth of reels, not 69 creators'.
- **Every creator added shifts the ground truth.** `performance_score` is a
  corpus-wide percentile; median share rate varies **10.4× between creators**,
  and creator identity alone explains ~**11.4%** of its variance.

Combined with `EVAL.md`'s finding that unpaired corpus changes below ~0.13 are
undetectable at n=253, **corpus growth cannot be justified on the headline
moving.** Justify it on coverage, and settle the within-creator percentile
question first — otherwise a large intake changes what every existing score
means.

### 4. Display-count deviation from the client brief — Allen still needs telling

The brief specifies 10 ranked title ideas. The app generates 10, sorts by
`templateSimilarityPrior`, and displays the best 5 (`DISPLAY_COUNT = 5` in
`lib/generation/constants.ts`; all 10 are still persisted as future eval data).
This is a deliberate product change made to make the prior load-bearing rather
than decorative — but it is a project-owner decision, not an engineering call,
and it has not been run past Allen.

### 5. Nobody has checked the ranked order in a real browser

The sort is verified in the API response and in tests. Nobody has opened the app,
generated titles, and confirmed the 5 displayed titles render in descending
badge/prior strength. Needs a human; a subagent could not drive a browser to
check it. Relevant now that `feature/UI-Initial` is the active branch.

### 6. Known bug — `refresh-metrics.ts` applies the wrong gate to `henryjwade`

It applies the *outliers* gate to a creator who was scraped in *top-bottom* mode.
Its "new candidates" for him are mid-pack, not top-50. Not recommended for
addition. Fix before trusting that section again.

### 7. Six legacy votes in `title_feedback` cannot be attributed correctly

`title_feedback.title_index` means different things either side of commit
`5730038`. Before it, the API returned all 10 generated titles unsorted, so an
index points into the raw array and can legitimately be 5–9. After it, titles
are persisted already sorted and the app shows the best 5, so the index points
into `displayTitles(raw)`.

`scripts/review-feedback.ts` uses the post-`5730038` basis, which is correct for
every vote from now on. The cost is confined to the six rows that predate it:
one has an index ≥ 5 and is **silently dropped** from the review file (6 rows in,
5 rendered), and the 26 May and 4 Aug rows may name the wrong title. No single
code path satisfies both eras — fixing it means a per-row cutoff on
`title_feedback.created_at`, not a change of basis. Left unremediated
deliberately: five historical votes.

Related: every one of those votes groups under `@(unattributed)`, because
`generation_attempts.creator_handle` did not exist when they were written. Not a
bug — the information was never captured. New generations carry it.

### 8. `sanitizeAvoidTitles` keeps the oldest ten rejections, not the newest

`lib/feedback/rules.ts` truncates the avoid list with `.slice(0, 10)`. Past ten
rejections on a single clip, the creator's *newest* thumbs-down stops reaching
the prompt while stale ones persist — the opposite of what they'd expect. Minor
in practice (ten rejections on one clip is a lot), but it is backwards.

### 9. Smaller open threads

- **Relabel or drop the `comments` column** — it counts top-level comments only,
  which is not what a reader assumes.
- **Re-investigate reposts.** They *are* public and visible in the UI. The earlier
  conclusion that they were unobtainable was based on documentation rather than
  the app, and was wrong.
- **Niche selector** (deliverable 5, stretch) — `app/(app)/page.tsx` still
  hardcodes `niche_id: 'luxury-menswear'` and `creator_handle: 'william_j_wade'`.
- **Stale branch** — `feat/eval-harness` points at the same local commit as the
  merged work but its remote is 20 commits behind. Safe to delete.
- **No CI.** There is no `.github/` directory. The 256 tests and the typecheck
  run only when someone runs them.
- **Anthropic spend cap.** Generation returns a 400 until the monthly limit
  configured in the Anthropic Console is raised. This is a billing setting, not
  a code fault, and it blocks end-to-end testing of the generate and like paths.

---

## Revisiting the taxonomy — what that actually means

**Deferred 2026-08-09 (see open item 1). Kept here for whoever picks it up.**

Not "re-run the classifier". The categories themselves are the problem, so the
decision is what to replace them with. Four options, cheapest first:

**A. Derive families from the corpus instead of declaring them.**
Cluster the 259 title embeddings, read the clusters, and name what is actually
there. `scripts/audit-taxonomy.ts` already prints sample titles per cluster, so
most of the work is done. Risk: clusters at k=5 have 27–83 members and purity
0.386, so they may not be crisply nameable either — the honest outcome could be
"there are three families, not five."

**B. Drop `hook_family` from the generation path entirely.**
The prior already ignores it (`FAMILY_PRIOR_BLEND = 0`). What remains is the
few-shot labels and the required-families constraint. Test whether either helps:
the eval can measure the prior, but the *generation* effect needs a separate
A/B, since the eval never scores generated titles. Cheapest option, and the null
result is a legitimate outcome.

**C. Replace the constraint with a diversity mechanism that has no labels.**
The required-families constraint exists to stop the model emitting ten variations
of one hook. MMR already diversifies the retrieved examples in title space; the
same idea could enforce spread on the generated slate directly, with no taxonomy
involved.

**D. Keep five families but re-derive them from titles, not from vibes.**
The current triggers (`'mundane'`, `'awkward'`, `'getting-ready'`) describe the
*video*, while the families are meant to describe the *title's structure*. That
mismatch alone could explain a lot of the misfit.

**How to decide.** Run the audit's cluster dump and read the actual titles first —
that is a 10-minute, zero-cost read that tells you whether A is viable. If the
clusters do not name cleanly, B is the honest fallback. Whatever changes, note
that a taxonomy change is a **paired** eval comparison (same corpus, ±0.011
floor), so it *is* measurable — unlike corpus growth. See `EVAL.md` →
"What size of change this harness can actually detect".

---

## Decisions that still hold

### Performance metric

Full reasoning: `docs/findings/2026-08-02-performance-metric-decision.md`

- **Primary: `performance_score`** = percentile rank of `share_rate`
  (`shares/views`), 0–1
- **Secondary: `view_outlier_score`** = percentile rank of `views / creator median`
- Raw `share_rate` and `view_outlier` are also stored, so scores can be
  re-derived without a re-scrape

Share rate is the engagement behaviour most attributable to the *title* — a like
reacts to the video, forwarding it is triggered by the line — and it is causally
upstream of reach. **Rejected:** full engagement `(l+c+s)/v` correlates 0.960
with plain engagement rate; likes swamp shares and launder the best signal into
the weakest.

Consequences that bite:

1. **A null `performance_score` is unscored, NOT zero.** A zero ranks a
   genuinely-unmeasured video at the bottom and teaches the model its title
   failed. Six rows are affected.
2. **An empty `shares` cell means no reading, never zero.**
3. **Percentiles are corpus-relative.** Appending rows invalidates every existing
   score. `import-dataset.ts` therefore replaces the whole table; never append
   rows carrying stale percentiles.

### Retrieval runs in description space, not title space

`corpus_titles` carries **two** embedding columns and they do different jobs:

- `description_embedding` → relevance ("which corpus videos look like this?")
- `embedding` (title) → MMR diversity and `computeTitlePrior`

One vector cannot serve both. MMR must spread the 8 chosen examples apart *as
titles*; running it on description vectors could return eight different scenes
whose hooks are all phrased identically — the opposite of useful for few-shot
prompting.

Measured when this was fixed (`npm run verify:retrieval`): neighbour similarity
0.57–0.91 in description space versus 0.34–0.51 in title space, and the two
paths overlapped on 0/4, 1/4, 1/4 across three probes. Almost entirely different
rows — a real defect, not tuning.

### How extraction works

Each video is read **once** by `claude-sonnet-4-6` over 8–12 frames. Hook titles
are separated from speech captions by **behaviour across frames** (a title is
identical in every frame; captions change constantly), never by screen position.

A **second, offset-sampled read** runs only when pass 1's evidence is weak, or
when acting alone would discard a row. Conflicts are quarantined, never guessed —
`datasets/raw/_quarantine-review.md` holds both passes' evidence per video, and
`scripts/apply-human-review.ts` carries the 27 reviewed decisions from the
backfill (8 promoted, 19 excluded) with a reason recorded on each.

Descriptions reuse `lib/providers/anthropic/vision.ts` **unchanged** at exactly
8 frames with no options — reproducing the app's runtime call byte-for-byte,
including its 16-second coverage limit, because retrieval compares corpus
descriptions against the description the app generates at upload time. Both
sides must come from the same prompt, model and sampling. **22% of videos exceed
16s** and are described from their opening only.

### Backfill selection

`scripts/lib/reject-sampler.ts`. Two rules, both deliberate:

- **A 20,000-view floor, as a precision requirement, not a quality one.** At
  2,000 views a representative 0.004 share rate carries ~35% relative standard
  error; at 20,000 it is ~11%.
- **No selection on the multiplier band within the floor.** Reach is a lottery;
  filtering on views while measuring shares/views would be selecting on noise.

### Metrics availability (tested, not assumed)

| metric | Apify | SocialCrawl |
|---|---|---|
| views | ✅ `videoPlayCount` | ✅ agrees to 0.002% |
| likes / comments | ✅ | ✅ |
| **shares** | ❌ | ✅ |
| **reposts** | ❌ | ❌ (but see open item 7 — they are public) |
| **saves** | ❌ | ❌ (`null` on every reel, incl. premium) |

The brief's claim that `saves` is "the most valuable column" is **obsolete** —
Instagram hides the feature and no source supplies it. `datasets/README.md` was
corrected.

**SocialCrawl gotcha:** `credits_remaining` reports **0 on cached responses**.
Only trust it when `cached === false`. This nearly caused a false "out of
credits" panic twice.

---

## Defects and corrections — the history that still matters

### The views column mixed two metrics

`docs/findings/2026-08-02-view-metric-inconsistency.md`

`scrape-instagram.ts` preferred `videoViewCount` over `videoPlayCount`.
Instagram returns **both**; they disagree by **2.6×–130×**. ~88% of stored views
were 2–3× too low with nothing marking which rows. Fixed at source and repaired
across 1,828 rows. **This invalidated an earlier metric analysis** done on the
corrupt column; that analysis was discarded and redone.

### Bulk share collection was the wrong tool

`/profile/reels/full` performs an internal per-reel shares fanout (~17s per
10-item page). Target rows sit deep in each profile, so paging burned ~690
credits, hit repeated 504s, and filled no rows. Replaced by
`scripts/collect-shares-direct.ts`, which looks each post up individually via
`/instagram/post/stats` at 5 credits flat.

### CORRECTION 2026-08-03 — the cross-source audit verified agreement, NOT correctness

A UI spot-check on `rsimacourbe/Da3fJwKA6HZ` found our data disagrees with
Instagram: likes 8,578 vs 10.8K (~21% low), comments 76 vs 147 (~48% low).

**The earlier "likes 111/111, comments 111/111" audit does NOT mean the metrics
are correct.** It means Apify and SocialCrawl agree with *each other* — they
appear to read the same upstream field, so they can agree perfectly while both
differ from the app. This is the same failure mode that hid the view-metric bug:
internal consistency mistaken for correctness.

Impact: **none on titles or visual descriptions** (both derive from video frames,
never from metrics), and **none on likes/comments consumers, because there are
none** — `computeTitlePrior` reads only `performance_score`, and neither
`performance_score` nor `view_outlier_score` uses likes or comments. They are
descriptive columns only. The live consequence is open item 2.

Also from that check: **`shares` (2,037) is NOT reposts (70).** It is almost
certainly DM sends, which the UI does not display.

### CORRECTION 2026-08-08 — cross-import eval comparisons were invalid

`corpus_titles.id` is `uuid default gen_random_uuid()` and `import-dataset.ts`
replaces the whole table, so **row order changed on every import**. Row order
feeds the seeded fold partition, so the headline moved when nothing in the data
had changed — a 0.083 range on one fixed corpus, comparable to the headline
itself.

Fixed by re-sorting on `(title, hook_family)` after fetching. **Any comparison of
headline numbers across imports made before 2026-08-08 should be disregarded,**
including "0.259 → 0.304" as evidence the signal strengthened. Full detail in
`EVAL.md`.

---

## Operational notes

- **Migrations must be applied by hand in the Supabase dashboard.** The CLI is
  logged into a different account than the client project (`afywfsakawcknolsmgwi`),
  and the service-role key cannot run DDL. Every future migration needs the same
  manual step.
- **`parseCsv` in `scripts/lib/csv.ts` is a state machine, not a split** — a
  large share of rows contain embedded newlines.
- **7 titles appear twice** on different shortcodes; creators genuinely reused a
  hook. Legitimate data, but the eval must not treat them as independent samples —
  `eval-split.ts` groups them so they never split across folds.
- **`seed-corpus.mjs` refuses to insert invented titles** without
  `--force-fake-seed`, so it cannot silently undo the purge of the original 250
  hand-invented seed rows.
- **Security:** the builder brief `.docx` files in the repo root contain live
  client credentials. `*.docx` is gitignored — do not remove that line.
  `SOCIALCRAWL_API_KEY` lives in `.env.local` (also gitignored).

---

## Other records

- `EVAL.md` — the eval harness, its baseline, its uncertainty analysis, and what
  size of change it can actually detect. Read this before making any claim about
  performance.
- `docs/findings/` — the two metric investigations
- `.superpowers/sdd/2026-07-31-burn-in-title-ocr/progress.md` — full decision
  ledger, every deferred finding with its ruling
- `docs/superpowers/specs/` and `plans/` — design and implementation plans for
  the OCR pipeline, client-side upload prep, the eval harness, and the title
  feedback loop
- `datasets/raw/_title-feedback.md` — every vote with the visual description it
  was generated for; regenerate with `npm run review:feedback`
- `datasets/raw/_quarantine-review.md` — quarantined videos with both passes'
  evidence
- `datasets/raw/_metrics-refresh-report.md` — per-creator selection analysis
- `datasets/raw/_shares-audit.md` — cross-source audit
- `datasets/creator-shortlist.md` — 69 candidates for the next expansion, with
  the budget and ground-truth constraints that bound it
