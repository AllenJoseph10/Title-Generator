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
  interpreting its sign**, and read it alongside the line printed directly
  under it:
- **`permuted-family null` (1000 draws)** — the measured null for the baseline
  above. Reshuffles which row carries which `hook_family` label and reruns
  that identical estimator, so it captures the leave-out construction penalty
  *and* the taxonomy's chance-level between-family variance together. Whether
  the observed baseline lands inside or outside this null is printed on the
  same line, in SDs.
- **`family mean (in-sample, reference)`** — the same estimator, but computed
  over every eligible row including the one being scored (no leave-out).
  Printed only so the gap against the out-of-fold figure is visible; it is
  not itself a baseline the headline needs to beat.
- **`constant 0.5`** — always `n/a`. Spearman correlation is undefined for a
  constant series (zero variance); the line exists to document that a
  baseline that predicts the same neutral prior for every row cannot be
  scored this way, not because something broke.

### The out-of-fold family-mean baseline is biased low — and the eval measures it

`family mean (train, out-of-fold)` reads **≈ −0.101**, which is **not**
evidence that hook family is anti-predictive. A leave-fold-out group mean
excludes each held-out row from its own family's mean before scoring it
against that mean, so it systematically loses covariance with the row it
predicts. The penalty is ≈ `k·σ²/N` — governed by corpus size `N` and family
count `k`, so it does shrink as the corpus grows. Family size enters only
through `N_F/(N_F−1)` (1.02–1.14 here, a ≤14% effect); small families matter
instead as the *amplifier*, because a predictor taking one value per family
per fold has low variance, and a low-variance predictor turns a modest
covariance penalty into a larger-looking correlation. Derivation in
`scripts/eval.ts`, on `Prediction.familyMeanTrain`.

The eval does not stop at that derivation, because it accounts for only
≈ −0.034 of the ≈ −0.101 observed. The **permuted-family null** (1000 draws)
reshuffles which row carries which `hook_family` label — fold partition,
ground truth and estimator all held fixed — and reruns the identical
baseline. It reads **−0.076 ± 0.107**, and the observed −0.101 sits **0.23 SD
inside it**. The negative sign is therefore construction plus chance-level
between-family variance, measured rather than assumed. (It equally does not
show hook family *has* signal: a null that wide could not detect a modest
effect on 172 rows.) `family mean (in-sample, reference)` (≈ +0.122) is the
same estimator with the opposite-signed bias — each row contributes to the
mean it is scored against — so the two bracket the unbiased value from
opposite sides.

The headline is **not** exempt from this penalty. `performance_score` is a
percentile rank over a fixed population, so every pairwise covariance is
−σ²/(N−1) and *any* mean over a subset excluding row i pays the same price,
the headline's neighbour mean included; subset size does not change it,
predictor variance does. The headline's 5-row neighbour mean has sd ≈ 0.45σ
against the family mean's ≈ 0.17σ, so its penalty is ≈ −0.013 against the
baseline's ≈ −0.034 — **a smaller analogous penalty, because the prior's
predictor varies far more than a family mean does**, not an absent one. Read
the headline-vs-baseline comparison as **directional**, not as a precise
numeric margin.

**Slate precision** — the product-facing metric. Sample `--slate-size` (10)
held-out rows, rank by prior, ask how many of the top k were truly top k, over
200 slates per repeat. Analytic random ranking gives 0.300 at k=3 and 0.500 at
k=5; a **shuffled null** — the predictions permuted within each slate, same
structure as the headline's permutation null — reports what random ranking
actually scores on this data, with its own per-slate spread. Read the gap
against that null, not against the analytic value alone.

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
things. Check 2 is the falsifiable one; check 1 is a regression guard.

1. **Row/actual pairing — a regression guard, not a live test.** Every
   `Prediction.actual` is compared **element-wise for exact equality** against
   `Prediction.row`'s own ground truth column. As `runRepeat` is written
   today, both are set from the same row reference inside one object literal,
   so this **cannot fail** — it asserts an invariant that currently holds by
   construction. It exists to fail *later*, if a refactor decouples the two
   (assembling predictions from parallel arrays, reordering, merging fold
   outputs by index). Exact equality rather than a correlation on purpose:
   Spearman returns 1.0 for any monotone relationship, so a rank-based version
   would pass on values that are systematically wrong but consistently
   ordered. Draw no evidence from this check passing.
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
    permuted-family null (1000 draws)        -0.076 +/- 0.107   (observed is -0.23 SD from it — INSIDE the null)
  baseline: family mean (in-sample, reference) 0.122 +/- 0.000
  baseline: constant 0.5                       n/a   (undefined by construction)

  note: the out-of-fold family-mean baseline is negatively biased under the null by construction (a leave-fold-out group mean loses covariance whether or not hook family has any real effect; the penalty is ~k*sigma^2/N, set by corpus size and family count). The permuted-family null above measures that bias directly, by reshuffling which row carries which hook_family label and rerunning the same estimator: the observed value sits inside it, so the negative sign is construction plus chance, not evidence about the taxonomy. The headline carries a smaller analogous penalty (every subset mean excluding row i does, on a percentile-rank ground truth) — smaller because the prior's predictor varies far more than a family mean does — so the two are directional, not a clean margin. The in-sample figure is the same estimator with the opposite bias. See EVAL.md.

family term fallback: 10.6% of predictions (no same-family neighbour retrieved; family term only == neighbour term for these rows)

slate precision (10 candidates, 200 slates x 5 repeats)
  @3   0.429 +/- 0.044 across repeats   (random 0.300; shuffled null 0.310 +/- 0.234 per slate, SE of null mean 0.007)
  @5   0.571 +/- 0.010 across repeats   (random 0.500; shuffled null 0.493 +/- 0.167 per slate, SE of null mean 0.005)
    the +/- across repeats is spread over 5 fold partitions of the SAME rows and the null's SE assumes slates are independent when they resample one 172-row pool — both understate uncertainty. Read the gap against the null as a direction, not a measured effect size.

by hook family
  transformation_tease    n=51    0.224
  setup_trivial_reveal    n=46    0.023
  relatable_pov           n=34    0.225
  reaction_humblebrag     n=33    0.411
  listicle_reveal         n=8     n/a (below 10)
```

**Interpretation:** The headline (0.232) sits roughly three sampling-SEs
(~0.076 each) above the 1000-draw shuffled null, which is now properly
centred close to zero (−0.003 ± 0.077). It also clears the `family term only`
figure (0.115) by roughly 0.12 — the closest thing in this report to evidence
that description-space retrieval contributes *beyond* the hook family, though
a heavily caveated one: `family term only` is itself retrieval-dependent (it
averages the same MMR-selected neighbours) and degenerates to the headline's
own neighbour term on the 10.6% of rows where no same-family neighbour is
retrieved, so the gap understates the difference between "retrieval" and "no
retrieval" and does not isolate either. It is also directionally above the
out-of-fold family-mean baseline (−0.101 ± 0.035) — but, per the subsection
above, that baseline is biased low by construction (its permuted-family null
reads −0.076 ± 0.107) and the headline carries only a smaller analogous
penalty, not none, so the two are not apples-to-apples and this reads as "the
prior beats a baseline that is itself biased downward," not as a precise 0.33
margin. That is a real, positive, but modest signal on a thin corpus: description-space
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
truth — reads **0.571 ± 0.010** (spread across the 5 repeats) against a
**0.500** analytic random baseline and a **0.493 ± 0.167** measured shuffled
null (per slate). That is evidence about the ranking signal, not a measurement
of the shipped feature, because it is measured on corpus titles the app
already has ground truth for, not on titles the model generates at request
time.

**The comparison also assumes something it does not measure.** What the
5-of-10 change actually replaces is *emission order*, not random order. The
0.500 baseline is a fair stand-in only if the order the model emits titles in
is uncorrelated with their quality — plausible, but unstated until now and
untested here; if emission order already carried some quality signal, the true
improvement is smaller than 0.571 − 0.500.

**On the size of the margin.** The +0.078 gap over the shuffled null is about
0.47 of one slate's SD, and roughly 15 SEs of the null's *mean* — but that SE
treats 1000 slates drawn from the same 172 rows as independent, which they are
not, and the ±0.010 across repeats is spread over 5 fold partitions of those
same rows. Both understate the uncertainty, whose real limit is corpus size.
The honest statement is therefore: the ordering clears its own shuffled null
in a consistent direction, on a corpus too thin to pin the size of the edge.
Do not read it as validation that the 5-of-10 change works well in production.

## Flags

| Flag | Default | Purpose |
|---|---|---|
| `--seed <n>` | `20260804` | Reproducibility; also seeds the null draws and slate sampling |
| `--repeats <n>` | `5` | Number of independent stratified 5-fold splits to average over |
| `--ground-truth <col>` | `performance_score` | `view_outlier_score` runs the alternative ground truth |
| `--family-blend <x>` | `0.3` | Weight on the family term in `computeTitlePrior`; `0` isolates neighbours, `1` gives family-term-only |
| `--slate-size <n>` | `10` | Candidates per sampled slate for the precision@k metric |
| `--sanity` | off | Runs the pairing and alignment-dependence checks described above; exits non-zero on failure |
