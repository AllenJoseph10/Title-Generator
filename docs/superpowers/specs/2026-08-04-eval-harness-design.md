# Eval Harness — Design

**Date:** 2026-08-04
**Status:** Approved design, ready for implementation planning
**Scope:** Deliverable 4 (`scripts/eval.ts` + `EVAL.md`). Includes a scoped follow-on — generate 10 titles, display the best 5 — which depends on the eval existing first.

---

## 1. Problem

The app ranks nothing and has never been measured.

`runPipeline` generates 10 titles and attaches a `templateSimilarityPrior` to each. That number claims the title would perform well. Nobody has tested the claim, and there is no way to tell whether the prior carries signal or is noise wearing a badge.

### Current state

Two facts established while designing this, both load-bearing:

1. **No code sorts titles by the prior.** The only `.sort()` calls in the repo are internal to `lib/hooks/classify.ts` and `lib/retrieval/prior.ts`. `orchestrator.ts` maps over `genRes.titles` in model-emission order, `app/api/generate/route.ts` persists that order, and `components/app/title-list.tsx` uses the prior for exactly one purpose — rendering a low/med/high badge via `priorBucket`. The brief's "10 ranked title ideas" is not what ships.
2. **The corpus is real and loaded.** 175 rows, both embeddings populated on every row, 3 with a NULL `performance_score`. Percentile-ranked `performance_score` and `view_outlier_score` are the two candidate ground truths, correlated at only 0.410.

Because the prior currently drives only a badge, a broken prior is close to harmless. That changes the moment it selects which titles a user sees — which is what §9 proposes. The eval must exist first, or the change ships unmeasured.

### Why a generated title cannot be the unit of measurement

There is no ground truth for a title that was never posted. Judging generated titles requires an LLM judge, which costs money per run and drifts between runs — the opposite of a metric tracked over time.

The design inverts it: **score held-out real titles whose true performance is known.** A held-out corpus row stands in for a generated candidate, and its percentile is the ground truth.

---

## 2. Goals

- Produce one headline number, repeatable across runs, that says whether the prior ranks better than chance.
- Reproduce the app's real scoring path, so a bad number implicates something the app actually does.
- Report a per-hook-family breakdown (required by the brief).
- Cost nothing per run and complete in seconds, so it can be re-run on every change.
- Make leakage impossible by construction, and disclose the one form of it that cannot be removed.
- Give Phase 2 a before/after comparison.

## 3. Non-goals

- **Evaluating generated titles.** No LLM judge, no generation calls. Deliberate — see §1.
- **Evaluating the vision or OCR stages.** Descriptions are taken as given.
- **Gating CI.** This is a measurement, not a pass/fail test. It always exits 0.
- **Fixing the hook taxonomy.** The eval measures the taxonomy's cost (§6.4); acting on that is separate work.
- **Growing the corpus past 200 rows.** Tracked as an open item elsewhere.

---

## 4. Decisions

| Decision | Choice | Why |
|---|---|---|
| What is scored | The prior only | Zero cost, deterministic, directly answers the brief's question |
| File format | `scripts/eval.ts` via `npm run eval` | Matches `import-dataset.ts`; lets the eval import `prior.ts` rather than duplicate it |
| Fidelity | Reproduce the retrieval funnel | Measures the path the app executes |
| Resampling | Repeated stratified group k-fold | A single 35-row holdout is not repeatable |
| Ground truth | `performance_score`, with `view_outlier_score` behind a flag | The 0.410 disagreement is the experiment |

### 4a. Why the funnel is reproduced rather than approximated

In the app, `computeTitlePrior` never sees the corpus. It sees the 8 rows that survived `retrieveAndRerank`: description-space similarity → top 30 → MMR at λ=0.6 → 8. Scoring against the whole training set would measure a code path the app never runs, and a good number there would not imply a good app.

The eval therefore rebuilds that funnel in memory using the same `mmrRerank` and `cosineSimilarity` the app uses.

**Consequence:** a poor headline number implicates retrieval, MMR and the prior *together*, not the prior alone. This is the correct granularity — the user experiences the composition, not the parts. Isolating a blamed component is follow-up work, and `--family-blend 0` already provides one such probe.

### 4b. Why constants must be exported, not copied

`search.ts` holds `RPC_LIMIT = 30`, `FINAL_K = 8` and `MMR_LAMBDA = 0.6` as module-private constants. The eval needs identical values.

Copying them creates a silent drift bug: someone tunes MMR in the app, the eval keeps measuring the old funnel, and the number stays comparable to history while no longer describing the product. **Export the three constants from `search.ts` and import them in the eval.**

Phase 1 makes exactly two changes to existing library code, both additive and both behaviour-preserving:

1. `search.ts` — export `RPC_LIMIT`, `FINAL_K`, `MMR_LAMBDA` (currently module-private).
2. `prior.ts` — add an optional trailing `blend` parameter to `computeTitlePrior`, defaulting to the existing `FAMILY_PRIOR_BLEND`. Required by the family-only baseline (§6.2) and the `--family-blend` flag (§6.5).

Every existing call site and the app's runtime behaviour are unchanged by both.

### 4c. Why repeated k-fold rather than one 20% split

The brief says "hold out ~20%". Five folds *is* 20% per fold, so the letter is satisfied — but every row gets tested exactly once per repeat instead of 35 rows being tested and 137 wasted.

With n=172, a single split's Spearman swings materially on the seed. A number that moves ±0.15 depending on an arbitrary constant cannot be "tracked over time", which the definition of done explicitly requires.

---

## 5. Architecture

Three files, splitting pure logic from orchestration:

| File | Responsibility | Tested |
|---|---|---|
| `scripts/eval.ts` | Load corpus, run folds, print the report | Manually |
| `scripts/lib/eval-split.ts` | Grouping, stratification, fold assignment, seeded RNG | Unit |
| `scripts/lib/eval-metrics.ts` | Spearman, slate precision@k, baselines | Unit |

Reused unchanged: `computeTitlePrior` from `lib/retrieval/prior.ts`, `mmrRerank` and `cosineSimilarity` from `lib/retrieval/mmr.ts`, `loadEnvLocal`/`requireEnv` from `scripts/lib/load-env.ts`.

`retrieveAndRerank` is **not** reused — it issues a Postgres RPC against the whole table and offers no way to exclude held-out rows. The eval reimplements the funnel over an in-memory training set using the same primitives and the constants from §4b.

### 5.1 Data flow

Load all 175 rows once (`id, title, hook_family, performance_score, view_outlier_score, embedding, description_embedding`), then per held-out row:

```
row.description_embedding
  → cosine vs every training row's description_embedding
  → top RPC_LIMIT (30)
  → mmrRerank on title embeddings, k = FINAL_K (8), λ = MMR_LAMBDA (0.6)
  → computeTitlePrior(row.embedding, row.hook_family, those 8)
  → (predicted, actual)
```

`row.embedding` is the row's own title vector, standing in for a generated title's vector. No embedding API call is made anywhere.

### 5.2 Fold scheme

- **Groups:** rows keyed by normalised title (trimmed, lowercased, whitespace-collapsed). The 7 titles appearing on two shortcodes each form one group. A group is never split across folds.
- **Stratification:** by `hook_family`, so `listicle_reveal` (8 rows) appears in every fold rather than clustering into one.
- **Folds:** 5. **Repeats:** 5, each with a different derived seed.
- **Per repeat:** every eligible row is predicted exactly once out-of-fold, giving 172 pairs → one Spearman. Five repeats → mean ± sd.

Aggregating within a repeat rather than per fold is deliberate: a Spearman over 35 points is noisy, and averaging five noisy fold-level numbers is worse than computing one over all 172 out-of-fold predictions.

- **RNG:** a small seeded PRNG in `eval-split.ts` (mulberry32). `Math.random` is never called — the run must be byte-identical for a given seed. Default seed `20260804`, overridable with `--seed`.

### 5.3 Eligibility

| Rows | Train | Test |
|---|---|---|
| 172 with a `performance_score` | yes | yes |
| 3 with NULL | yes | **no** |

A NULL row has no ground truth, so it cannot be scored — but it is still a legitimate neighbour, exactly as in the app, where `computeTitlePrior` filters NULLs out of the mean rather than dropping the row.

---

## 6. Metrics

### 6.1 Spearman rank correlation — the headline

Rank correlation between predicted prior and actual ground truth across all out-of-fold predictions in a repeat. Ties take average ranks (prior values collide readily, since a fallback of exactly 0.5 is returned whenever neighbours are empty).

Reported as **mean ± sd over 5 repeats**.

### 6.2 Baselines — mandatory, not optional

A Spearman of 0.15 reads as a result until the shuffled baseline also returns 0.12. Three baselines print alongside the headline:

| Baseline | What it rules out |
|---|---|
| Shuffled predictions | The metric is noise |
| Constant 0.5 | Degenerate, must yield undefined/zero |
| Family mean only | The neighbour search adds nothing over knowing the hook family |

The third is the demanding one. If the headline does not beat family-mean-only, description-space retrieval is contributing nothing and that is the finding.

**All three are computed inside the default run**, not by re-invoking with flags. The family-only baseline re-scores the same folds with `blend = 1`, which reuses the already-retrieved neighbours and costs one extra arithmetic pass — no second retrieval. `--family-blend` (§6.5) exists separately, to override the *headline* configuration for ablation.

### 6.3 Slate precision@k — the product-facing metric

Global top-3 does not mirror the product. The app's real question is: *given N candidates for one video, are the ones it surfaces the good ones?*

So the eval samples slates of `--slate-size` (default 10) held-out rows without replacement, ranks each slate by predicted prior, and measures overlap with the slate's true top-k:

```
precision@k = |top-k by prediction ∩ top-k by actual| / k
```

Averaged over 200 seeded slates. Reported at k=3 (named in the brief) and k=5 (Phase 2's display count).

Random-ranking baselines are analytic, so no simulation is needed: for a slate of 10, expected precision@3 is 3/10 = 0.30 and precision@5 is 5/10 = 0.50. Beating 0.50 at k=5 is the bar Phase 2 must clear to justify itself.

### 6.4 Per-family breakdown

Spearman within each `hook_family`, with counts. A family with fewer than 10 out-of-fold predictions reports `n/a (n=8)` — never a correlation computed on a handful of points.

This is also where the taxonomy question gets answered. 90 of 175 titles were force-fitted with low confidence; if the low-confidence families show near-zero correlation while high-confidence ones do not, the taxonomy is the bottleneck rather than the corpus.

### 6.5 Flags

| Flag | Default | Purpose |
|---|---|---|
| `--seed <n>` | `20260804` | Reproducibility |
| `--repeats <n>` | `5` | Tighter or faster estimates |
| `--ground-truth <col>` | `performance_score` | `view_outlier_score` runs the 0.410 experiment |
| `--family-blend <x>` | `0.3` (app value) | `0` isolates neighbours; `1` gives the family-only baseline |
| `--slate-size <n>` | `10` | Match the candidate pool |

`--family-blend` requires threading a blend parameter into `computeTitlePrior`, which currently hardcodes `FAMILY_PRIOR_BLEND = 0.3`. Add an **optional** trailing parameter defaulting to the existing constant, so every existing call site and the app's behaviour are untouched.

---

## 7. Leakage controls

1. A test row is never in its own training set.
2. Duplicate titles are grouped and move between folds together — otherwise a held-out row retrieves its twin at similarity ≈ 1.0 and scores perfectly for the wrong reason.
3. NULL-ground-truth rows never enter the test set.
4. **Disclosed, not fixed:** `performance_score` is a percentile computed over all 175 rows, so the ground-truth *scale* was fitted with test rows present. The effect is one row's rank among 175 — small, but real. Recomputing percentiles per fold would remove it while making the eval measure a metric the app does not ship. The trade is documented in `EVAL.md` rather than hidden.

---

## 8. Output

Plain text to stdout, designed to paste into `EVAL.md`:

```
eval — 172 rows, 5-fold × 5 repeats, seed 20260804
ground truth: performance_score        funnel: top-30 → MMR(8, λ=0.6)

Spearman (headline)      0.### ± 0.###
  baseline: shuffled     0.### ± 0.###
  baseline: family-only  0.### ± 0.###

slate precision (10 candidates, 200 slates)
  @3   0.###   (random 0.300)
  @5   0.###   (random 0.500)

by hook family
  transformation_tease    n=52   0.###
  setup_trivial_reveal    n=47   0.###
  relatable_pov           n=34   0.###
  reaction_humblebrag     n=34   0.###
  listicle_reveal         n=8    n/a
```

A loud warning prints when the headline does not clear the shuffled baseline. **Exit code is 0 regardless** — a measurement that fails the build gets deleted or muted; one that reports honestly gets read.

---

## 9. Phase 2 — generate 10, display the best 5

Depends on Phase 1. The baseline must be recorded **before** the prior gains authority over what users see.

| File | Change |
|---|---|
| `lib/generation/orchestrator.ts` | Sort `titles` by `templateSimilarityPrior` descending. One line. |
| `lib/generation/orchestrator.ts` | Export `DISPLAY_COUNT = 5` |
| `app/api/generate/route.ts` | Persist all 10 sorted; return `slice(0, DISPLAY_COUNT)` |
| `app/api/generation/[id]/route.ts` | Same slice, so history matches what was shown |

**Generation still emits 10.** `TITLE_COUNT`, both provider schemas, the `minItems`/`maxItems` bounds, the validators and the "apply to ALL 10 titles" steering text are untouched. Cost is unchanged.

**Persist 10, display 5.** The 5 discarded titles are the only record of real generations with real priors attached — genuine future eval data on model output rather than corpus rows. Discarding them to save a few hundred bytes is a bad trade.

**Touching `orchestrator.ts` is sanctioned.** The brief fences it with "unless a task requires it"; the priors exist only there, so ordering cannot be established anywhere else without recomputing them.

**Deviation from the brief:** it specifies 10 ranked ideas. Showing 5 is a project-owner decision and must be stated in the handoff rather than left for Allen to discover.

**After Phase 2:** re-run with `--slate-size 10` and read precision@5 against the 0.50 random baseline. That number is the claim "selecting by prior beats showing the model's first 5", or its refutation.

---

## 10. Testing

Unit tests in the established `scripts/lib/*.test.ts` vitest style:

**`eval-metrics.test.ts`** — Spearman against hand-computed vectors: perfect positive (1.0), perfect negative (−1.0), known intermediate, all-ties (undefined, not NaN or 0), partial ties using average ranks. Slate precision on a slate whose ordering is known. Analytic random baselines.

**`eval-split.test.ts`** — no group split across folds; every eligible row tested exactly once per repeat; NULL-ground-truth rows never in a test set; stratification holds within tolerance; the same seed yields identical folds and a different seed does not.

No test asserts a particular headline value. The number is an empirical result, not a contract — pinning it would turn a corpus change into a spurious test failure.

---

## 11. Verification

1. `npm test` — all suites pass, including the new ones.
2. `npm run typecheck` — clean.
3. `npm run eval` — completes with no API calls and prints the full report.
4. Same seed twice → byte-identical output.
5. Different seed → headline within the reported sd.
6. Sanity check: substituting a row's own ground truth as its prediction must yield Spearman 1.0, confirming the metric is wired correctly.

## 12. Risks

| Risk | Handling |
|---|---|
| **The prior barely beats random.** 172 rows is thin. | A correct, reportable result — not an implementation failure. The metric decision doc already predicts that if neither ground truth predicts, the cause is corpus size. `EVAL.md` states this up front so the outcome is not read as a bug. |
| **Views may be under-reported.** Views are the denominator of `performance_score`; never checked against the Instagram UI. | Out of scope here, but `EVAL.md` records that the ground truth inherits any error in the views column. |
| **Small families give unstable per-family numbers.** | Suppressed below n=10, with the count shown. |
| **Runtime.** ~4,300 prior computations, each ~400 cosines over 1536 dims. | ~2.6 GFLOP — seconds in JS. If it disappoints, the description-similarity matrix can be precomputed once per repeat. |
| **Percentile leakage (§7.4).** | Disclosed; effect bounded at one rank in 175. |

## 13. Out of scope

- Generation-quality evaluation, LLM judges, human rating
- Retrieval-only metrics (recall@k against a labelled relevance set — no such labels exist)
- Corpus expansion to the 200-row floor
- Hook-taxonomy redesign
- The niche selector (deliverable 5)
