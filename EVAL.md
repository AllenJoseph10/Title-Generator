# Eval — does the prior rank titles better than chance?

`npm run eval`

## The question

The app attaches a `templateSimilarityPrior` to every generated title, and
that number claims the title would perform well. This measures whether the
claim holds.

## How it works

There is no ground truth for a title that was never posted, so generated
titles cannot be scored directly. Instead the eval scores **real corpus rows
whose performance is known**:

1. Hold out a fifth of the corpus; hide it from retrieval.
2. For each held-out row, rebuild the app's retrieval funnel over the
   remaining rows — description-space cosine, top 30, MMR(8, λ=0.6).
3. Score it with the app's own `computeTitlePrior`.
4. Compare the predicted ranking against the true performance percentile.

Repeated stratified 5-fold, 5 repeats, seeded. Every embedding already exists
in Postgres, so a run costs nothing and takes seconds.

## Ground truth

`performance_score` — the percentile rank of `share_rate` (`shares/views`)
across the corpus. `--ground-truth view_outlier_score` runs the alternative.
See `docs/findings/2026-08-02-performance-metric-decision.md`.

**Two caveats, both real:**

- **The percentile scale saw the test rows.** `performance_score` was computed
  over all 175 rows, so held-out rows contributed to the ranking they are
  scored against. The effect is one row's rank among 175. Recomputing
  percentiles per fold would remove it, at the cost of measuring a metric the
  app does not ship.
- **Views were never verified against the Instagram UI.** Views are the
  denominator of `performance_score` (via `share_rate`). Likes and comments
  are known to be ~21% and ~48% below what the app displays. If views carry a
  similar error, the ground truth inherits it.

## Reading the output

**Spearman (headline)** — rank correlation between predicted prior and true
performance, mean across repeats, with the fold-assignment spread alongside
it. See "On the headline's uncertainty" below before treating that spread as
a margin of error.

**Baselines.** A headline of 0.2-something means nothing until you know what
noise and what naive alternatives score:

- **`shuffled` (1000 draws)** — the noise floor. Predictions shuffled against
  fixed actuals, same distribution, no signal. 1000 draws (200 per repeat x
  5 repeats) because 5 draws badly undercharacterises a null whose own mean
  has a standard error comparable to its value.
- **`family term only` (blend=1)** — `computeTitlePrior` run with
  `--family-blend 1`, isolating its family term. This is **not** a
  retrieval-free baseline: the family term is averaged over the same
  MMR-selected neighbours that produced the headline, so it still depends on
  retrieval per row, and for any row whose retrieved neighbours share none of
  its hook family it degenerates to being byte-identical to the headline's
  neighbour term (the "family term fallback" line reports how often that
  happens — 10.6% of predictions on the current run).
- **`family mean (train, out-of-fold)`** — the genuine retrieval-free
  baseline: for each held-out row, the mean ground truth of its hook family
  computed only over that fold's training rows. No MMR, no per-row retrieval
  dependence, one number per family. **Read the note below before
  interpreting its sign.**
- **`family mean (in-sample, reference)`** — the same estimator, but computed
  over every eligible row including the one being scored (no leave-out).
  Printed only so the gap against the out-of-fold figure is visible; it is
  not itself a baseline the headline needs to beat.
- **`constant 0.5`** — always `n/a`. Spearman correlation is undefined for a
  constant series (zero variance); the line exists to document that a
  baseline that predicts the same neutral prior for every row cannot be
  scored this way, not because something broke.

### The out-of-fold family-mean baseline is negatively biased by construction

This is the single most important thing to understand about the output.
`family mean (train, out-of-fold)` currently reads **≈ −0.101**. That is
**not** evidence that hook family is anti-predictive. A leave-fold-out group
mean is negatively biased under the null by construction: each held-out row
is excluded from its own family's mean before being scored against it, so
the estimator systematically loses covariance with the row it predicts,
regardless of whether hook family carries any real signal. The size of that
bias is governed by how small the families are (8 to 51 rows here), not by
the total corpus size, and it shows up as a comparatively large correlation
because the predictor itself takes only a handful of distinct values (one
per family per fold) — a low-variance predictor turns even a modest
covariance penalty into a larger-looking correlation. The derivation lives
in `scripts/eval.ts` (the comment on `Prediction.familyMeanTrain`), not
reproduced here.

`family mean (in-sample, reference)` (≈ +0.122) is the same estimator
without that leave-out penalty — but it is biased in the *opposite*
direction, for the mirror-image reason: each row now contributes to the
very family mean it is being scored against, an upward bias rather than a
neutral one. The two figures therefore **bracket** the unbiased value from
opposite sides; neither one confirms the other's magnitude. The gap between
them (≈0.22) roughly locates the scale of the leave-out penalty, not a
precise measurement of it.

This also means the headline and the out-of-fold family-mean baseline are
**not** a clean, apples-to-apples comparison. Both are computed out-of-fold,
but only the baseline carries the group-mean construction penalty described
above — the headline carries no equivalent penalty. The sign of the
out-of-fold figure on its own is uninterpretable, and the comparison to the
headline should be read as **directional** (does the prior do better than a
baseline that is itself biased low) rather than as a precise numeric
margin.

**Slate precision** — the product-facing metric. Sample `--slate-size` (10)
held-out rows, rank by prior, ask how many of the top k were truly top k, over
200 slates per repeat. Random ranking gives 0.300 at k=3 and 0.500 at k=5.

**By hook family** — families below n=10 print `n/a`. 90 of 175 titles were
force-fitted into a family with low confidence, so a family scoring near zero
may be a labelling failure rather than a prior failure.

### If a `!! WARNING` or `!! NOTE` line appears

The script prints these only when a comparison looks bad; the current run
(below) triggers none of them. If a future run does:

- **`!! WARNING` (shuffled)** — the headline does not clear the shuffled
  permutation-null baseline plus one SD. The prior is not distinguishable
  from noise on that run's corpus/config; treat the headline as
  uninformative until this clears.
- **`!! NOTE` (family term only)** — the headline does not beat the
  `family term only` (blend=1) figure. As covered above, that figure is
  retrieval-dependent, not a retrieval-free baseline, so this note flags a
  comparison worth a closer look rather than a verdict on retrieval's value.
- **`!! WARNING` (family mean, out-of-fold)** — the headline does not beat
  the out-of-fold family-mean baseline. Even though that baseline is itself
  biased low by construction (see the subsection above), failing to clear it
  is a stronger signal than the raw numbers alone suggest and is worth
  investigating. It does **not**, on its own, establish that description-space
  retrieval adds nothing over hook family — it means the comparison should
  be examined, not treated as a settled conclusion.

### On the headline's uncertainty

The headline line prints two different numbers and they answer different
questions:

- **Fold-assignment spread** (the number next to the headline, ≈0.023) — how
  much the Spearman value moves across 5 different random fold partitions of
  the *same* 172 rows. This is sensitivity to the luck of the fold draw, not
  a confidence interval.
- **Sampling SE** (printed on its own line, ≈0.076 at n=172) — the analytic
  standard error of Spearman's rho under independence, `1/sqrt(n-1)`. This is
  the dominant source of uncertainty and is **over 3x** the fold-assignment
  spread. Treat this as the honest scale of "how much would this number move
  if we scored a different 172 rows drawn the same way," not the spread
  printed next to the headline.

## `--sanity`

`--sanity` does not compare the ground truth to itself (`spearman(x, x)` is
an algebraic identity — it returns 1.0 regardless of whether any row is
paired with the right prediction, so that check alone would prove nothing).
Instead it runs one real repeat through the actual pipeline and asserts two
things that can genuinely fail:

1. **Pairing.** `Prediction.actual` is re-derived from `Prediction.row`'s own
   ground truth column and compared against the stored `actual` — must be
   exactly `1.000000`. Catches a bug that associates a row with someone
   else's ground truth.
2. **Alignment-dependence.** The predicted values are rotated against the
   fixed actuals at 10 fixed, deterministic offsets, and the mean `|rotated
   correlation|` must collapse below `3/sqrt(n)` (an absolute threshold
   anchored to the null's own scale, independent of how strong the current
   headline is). If the metric were insensitive to which prediction goes
   with which row, this would not collapse. Confirms the correlation
   genuinely depends on correct row alignment, not just on the marginal
   distribution of the two arrays.

Both checks throw (non-zero exit) on failure; the main report never does — it
is a measurement, not a gate.

## Current numbers

Run 2026-08-04, seed 20260804, 175-row corpus:

```
eval — 172 of 175 rows scoreable, 5-fold x 5 repeats, seed 20260804
ground truth: performance_score        funnel: top-30 -> MMR(8, lambda=0.6)
family blend: 0.3

Spearman (headline)      0.232 (fold-assignment spread 0.023 across 5 seeds)
  sampling SE (n=172)   ~0.076  (analytic, 1/sqrt(n-1) — the dominant uncertainty, not the spread above)
  baseline: shuffled (1000 draws)         -0.003 +/- 0.077
  baseline: family term only (blend=1)     0.115 +/- 0.026
  baseline: family mean (train, out-of-fold)  -0.101 +/- 0.035
  baseline: family mean (in-sample, reference) 0.122 +/- 0.000
  baseline: constant 0.5                       n/a   (undefined by construction)

  note: the out-of-fold family-mean baseline above is negatively biased under the null by construction (a leave-fold-out group mean loses covariance regardless of whether hook family has any real effect; the bias scales with family size, not corpus size) — only its comparison to the headline is meaningful, and even that comparison is directional, not a clean margin, since the headline carries no equivalent leave-out penalty. The in-sample figure is the same estimator with the opposite bias (each row contributes to the very mean it is scored against): the two figures bracket the unbiased value from opposite sides rather than one confirming the other. See EVAL.md.

family term fallback: 10.6% of predictions (no same-family neighbour retrieved; family term only == neighbour term for these rows)

slate precision (10 candidates, 200 slates x 5 repeats)
  @3   0.429   (random 0.300)
  @5   0.571   (random 0.500)

by hook family
  transformation_tease    n=51    0.224
  setup_trivial_reveal    n=46    0.023
  relatable_pov           n=34    0.225
  reaction_humblebrag     n=33    0.411
  listicle_reveal         n=8     n/a (below 10)
```

**Interpretation:** The headline (0.232) sits roughly three sampling-SEs
(~0.076 each) above the 1000-draw shuffled null, which is now properly
centred close to zero (−0.003 ± 0.077). It is also directionally above the
out-of-fold family-mean baseline (−0.101 ± 0.035) — but, per the subsection
above, that baseline is biased low by construction and the two are not a
clean apples-to-apples comparison, so this reads as "the prior beats a
baseline that is itself biased downward," not as a precise 0.33 margin. That
is a real, positive, but modest signal on a thin corpus: description-space
retrieval plus the app's blended prior orders held-out real titles better
than chance, but 0.232 is a moderate rank correlation, not a strong one, and
the sampling SE (~0.076) is large enough relative to the headline itself that
this should be read as "probably better than chance" rather than as a
precisely known effect size. Per-family results are uneven (0.023 to 0.411,
one family suppressed below the n=10 floor), consistent with a signal that is
real on average but not uniformly strong across hook families. This is
evidence the prior is doing something, not evidence it is doing it well.

## Known limits

- **172 scoreable rows**, below the brief's 200 floor. If the prior does not
  predict, corpus size is the first suspect, not the metric.
- The eval measures retrieval, MMR and the prior **together**. A poor number
  does not localise the fault; `--family-blend 0` is one probe for that.
- Nothing here evaluates title *quality* — only whether the prior's ordering
  matches real performance.

## Slate precision@5 as a proxy for the shipped 5-of-10 display

Task 6 changed the app to generate 10 titles, sort them by
`templateSimilarityPrior`, and display the best 5. This eval does not measure
that change directly, and re-running it after Task 6 produces numerically
identical output to before — the eval scores the prior against held-out
**corpus** rows; Task 6 touched only the app's display ordering, not the
prior, retrieval, or the corpus. There is no before/after here.

What the numbers above legitimately support is a proxy, not a direct
measurement: **slate precision@5** — rank 10 held-out *real corpus titles* by
the prior, take the top 5, count how many were genuinely top-5 by ground
truth — reads **0.571** against a **0.500** random-ranking baseline. That is
evidence about the ranking signal (prior-based ordering edges out picking 5
of 10 titles at random), not a measurement of the shipped feature, because it
is measured on corpus titles the app already has ground truth for, not on
titles the model generates at request time. The margin (0.571 vs. 0.500) is
real but modest — call it a modest edge, not validation that the 5-of-10
change works well in production.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--seed <n>` | `20260804` | Reproducibility; also seeds the null draws and slate sampling |
| `--repeats <n>` | `5` | Number of independent stratified 5-fold splits to average over |
| `--ground-truth <col>` | `performance_score` | `view_outlier_score` runs the alternative ground truth |
| `--family-blend <x>` | `0.3` | Weight on the family term in `computeTitlePrior`; `0` isolates neighbours, `1` gives family-term-only |
| `--slate-size <n>` | `10` | Candidates per sampled slate for the precision@k metric |
| `--sanity` | off | Runs the pairing and alignment-dependence checks described above; exits non-zero on failure |
