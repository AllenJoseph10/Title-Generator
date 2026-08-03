# Decision: performance metric for the title corpus

**Date:** 2026-08-02
**Decided by:** project owner
**Status:** Decided and implemented in `scripts/merge-dataset.ts`

---

## Decision

**Primary metric: `performance_score` — the percentile rank of `share_rate` (`shares / views`) across the corpus, as a 0–1 score.**

**Secondary, stored alongside: `view_outlier_score` — the percentile rank of `views / creator's median views`.**

Both raw values (`share_rate`, `view_outlier`) are emitted too, so the scores can be re-derived or re-scaled without a re-scrape.

## Why this replaces `save_rate`

The original design specified `save_rate = saves / views`. That is **not achievable**. Saves are not exposed by any source tested — Apify has no field at all, and SocialCrawl returns `null` on every reel including its premium endpoint. The feature is also now hidden in the Instagram UI. See `docs/findings/2026-08-02-view-metric-inconsistency.md`.

**`corpus_titles.save_rate_estimate` must be renamed.** It will not hold a save rate, and leaving the name invites exactly the misreading that caused this investigation.

## Evidence behind the choice

Measured across the 172 rows carrying a share count, on **corrected** view data (an earlier analysis on the pre-repair column was invalid and was discarded).

| metric | median | p95/p05 spread |
|---|---|---|
| share rate `s/v` | 0.0046 | **33×** |
| view outlier `v/median` | 4.24 | 692× |
| engagement `(l+c)/v` | 0.0368 | 7× |
| full engagement `(l+c+s)/v` | 0.0429 | 8× |
| share per like `s/l` | 0.1202 | 21× |

Spearman correlations:

```
        A(s/v)  B(out)  C(l+c/v)  D(l+c+s/v)  E(s/l)
  A     1.000   0.410     0.577      0.744    0.800
  B     0.410   1.000     0.378      0.415    0.213
  C     0.577   0.378     1.000      0.960    0.039
  D     0.744   0.415     0.960      1.000    0.248
  E     0.800   0.213     0.039      0.248    1.000
```

**Why share rate is primary.** Shares are the engagement behaviour most attributable to the *title* specifically — a like reacts to the whole video, but forwarding it to someone is usually triggered by the line itself. Shares are also causally upstream of reach (Instagram weights sends heavily), so a high share rate is closer to *what caused* distribution than a by-product of it. A 33× spread discriminates well, and the median rises with views (0.0022 under 50k → 0.0104 above 1M), so it does not reward low-reach videos.

**Why view outlier is kept alongside.** At 0.410 correlation it is the most *independent* signal available — it measures something share rate does not, namely whether a video escaped the creator's normal audience. It is free, complete on all 175 rows, and it is the rule the corpus was originally selected on. Storing both lets the eval measure which actually predicts better rather than committing blind.

**Why the others were rejected.**
- *Full engagement `(l+c+s)/v`* correlates **0.960** with plain engagement rate — likes swamp shares in the numerator, so it launders the hard-won share signal into the weakest metric. Actively harmful.
- *Engagement rate* has only a 7× spread, the least discriminating, and measures content satisfaction rather than hook effectiveness.
- *Share per like* is nearly orthogonal to engagement (0.039) and interesting as a diagnostic, but it is a ratio of two noisy quantities and hard to justify to a client. Not the primary score.

## Implementation notes

- **Percentile, not the raw ratio**, because both underlying metrics are heavily skewed (view outlier spans 692× p05–p95) and `corpus_titles` expects a bounded 0–1 value. Ties take the lower rank.
- **The view-outlier baseline is the median over ALL of a creator's scraped videos**, not just their included rows — a 4–10 row denominator would be far noisier. This matches `expectedViewsBaseline` in the scraper in spirit; it is a plain median, without the extremes-excluded cleaning step, because the corpus median is computed over a different population.
- **Percentiles are corpus-relative and will shift as rows are added.** They are a ranking, not an absolute measure. If rows are appended later, every score must be recomputed — do not append rows carrying stale scores.

## Consequences for the importer (deliverable 2)

1. **3 of 175 rows have no `performance_score`** (no share count — the API returned success with `null` on videos of 66, 104 and 14,847 views). The importer **must treat these as unscored, not as zero.** A zero would place genuinely unmeasured rows at the bottom of the ranking and teach the model that those titles failed. `merge-dataset.ts` prints a warning naming the count.
2. An empty `shares` cell means *no reading*, never zero.
3. `performance_score` is what should populate the renamed `save_rate_estimate` column consumed by `computeTitlePrior`.
4. `view_outlier_score` should be stored too, so the eval can compare both.

## What to check once the eval exists

Whether `performance_score` or `view_outlier_score` better predicts held-out performance. They agree only moderately (0.410), so they will disagree on a meaningful fraction of rows — that disagreement is the experiment. If neither predicts, the problem is the corpus size (175 rows, below the 200 floor), not the metric.
