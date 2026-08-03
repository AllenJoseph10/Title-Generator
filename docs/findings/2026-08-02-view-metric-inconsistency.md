# Finding: the `views` column mixes two incompatible Instagram metrics

**Date:** 2026-08-02
**Severity:** High — invalidates every view-derived number in the corpus, and may have skewed which videos were scraped in the first place.
**Status:** Diagnosed, not yet fixed.

---

## Summary

`datasets/raw/<handle>/manifest.json` and the generated `datasets/william-wade-titles.csv` carry a `views` column that is **not a single metric**. Depending on which fields Instagram returned for a given post, a row holds either:

- `videoPlayCount` — plays including replays, the figure Instagram currently surfaces as "views", or
- `videoViewCount` — an older, far stricter metric

The two disagree by **2.6× to 130×** on the same video. Nothing in the data marks which one a row contains.

Titles, descriptions, captions, durations, dates, likes and comments are **unaffected**. The problem is confined to `views` and everything computed from it.

---

## Root cause

`scripts/scrape-instagram.ts:195`

```ts
views: toNumber(pick(item, ['videoViewCount', 'videoPlayCount', 'playsCount', 'viewCount'])),
```

`pick` returns the first key present and non-null. `videoViewCount` is listed first, so whenever Instagram returns it, it wins — even though `videoPlayCount` is present in the same response with a much larger value.

The field list was almost certainly written assuming these were alternative *names* for one metric across API shapes. They are not; they are different metrics that can both appear at once.

---

## Evidence

### 1. Both fields are returned together, and they disagree

A live re-pull of `julesfrankenn` (12 most recent reels, 2026-08-02):

| shortcode | `videoViewCount` | `videoPlayCount` | ratio |
|---|---:|---:|---:|
| `DbKz0D-IZ9n` | 179 | 5,640 | 31.5× |
| `DbiFBOpiI4v` | 72 | 189 | 2.6× |
| `DbasY0KCjWU` | 66 | 190 | 2.9× |
| `DbXo5MkCoRe` | 12 | 128 | 10.7× |
| `DbS-g3iCs6r` | 34 | 330 | 9.7× |
| `Da8jfIciDyc` | 3 | 390 | **130.0×** |
| `DbiFwRSiAjV` | 41 | 161 | 3.9× |
| `DbiEMtciU1x` | 98 | 276 | 2.8× |
| `DbNPjzpCF0F` | 3 | 340 | **113.3×** |
| `Da8Du-1ChL1` | `null` | 150 | — |
| `Da8Eu5Iio7K` | `null` | 406 | — |
| `DbdnBe8ir2f` | absent | 2,708 | — |

10 of 12 returned both fields with different values. Where `videoViewCount` is `null` or absent, `pick` falls through to `videoPlayCount` — so those rows are correct by accident.

The ratio is **not constant**, so this cannot be corrected after the fact by rescaling.

### 2. Cross-source comparison rules out staleness

15 corpus reels checked against SocialCrawl's live API:

| metric | agreement |
|---|---|
| views | 5 of 15 within 15%; the rest 1.8×–3.0× apart |
| likes | all 15 within 5% |
| comments | all 15 within 5% (several *identical*) |

`julesfrankenn/DYj9jzMiIPV` has **identical comment counts** (73 vs 73) on a video whose views differ by 2.99×.

Stale data drifts on every metric at once. Likes and comments agreeing while views diverge is only consistent with the two sources reporting **different view metrics** — matching the field-precedence bug above.

An earlier hypothesis that Apify snapshots had simply gone stale was tested and rejected: the two closest-agreeing videos were *newer* than three of the four worst-disagreeing ones, the opposite of what staleness predicts.

---

## What this invalidates

**In the corpus:**

- the `views` column in all 175 CSV rows and in every manifest
- per-creator median views (previously reported as ranging 1,904 → 199,761)
- outlier multipliers (`views ÷ creator median`), stored as `outlierMultiplier`
- `viewsPerDay`

**In the scrape itself — the more serious half.** `scrape-instagram.ts` used these same view numbers to decide *which videos to download*:

- the `--mode outliers` gate (`views >= outlierMultiplier × baseline`)
- the `--mode top-bottom` split that selected henryjwade's best and worst
- the 1,292 rows marked `excluded_low_views`

A video whose `videoViewCount` read `3` while its real play count was `390` could have been rejected as a flop, or mislabelled `bottom` in the top/bottom split. The corpus composition may therefore be skewed, not merely the metrics attached to it.

**In prior analysis (2026-08-02 session):** the comparison of candidate performance metrics — engagement rate vs creator-relative view outlier, including the reported Spearman correlation of 0.05 and the recommendation to use view-outlier percentile — was computed on this mixed column. **Those conclusions do not stand.**

## What this does NOT affect

- burned-in titles — read from video frames, never from view counts
- visual descriptions — same
- `likes`, `comments`, `caption`, `duration_sec`, `date_posted`, `video_url`
- `title_template`
- the OCR pipeline's inclusion/exclusion decisions (driven by frame evidence, not metrics)

The expensive artefacts — 175 verified titles and 175 descriptions, ~$11.52 of API spend — are intact.

---

## Related finding: shares are available, saves are not

Investigated in the same session, since it bears on the same decision.

- The Apify actor in use (`apify~instagram-reel-scraper`) returns **no** share, send, repost or save field. Verified by deep-scanning 28 raw responses across 464 distinct key paths.
- **SocialCrawl** (`https://www.socialcrawl.dev/v1/instagram/post/stats?url=…`) returns `data.post.engagement.shares`. Coverage test: **14 of 15** reels returned a numeric share count, across every creator and every account size. The one miss was a 25-view video where the true value is plausibly zero.
- **Neither source returns saves.** The builder brief's framing of `saves` as "the most valuable column" is not achievable from any source tested, and per the project owner saves is in any case now a de-emphasised, hidden feature on Instagram.

Shares are a strong candidate signal: sending a reel is high-intent and effortful, and it is the behaviour that made saves valuable in the first place.

---

## Options

**A. Fix the field precedence and re-pull views from Apify.**
Change line 195 to prefer `videoPlayCount`. Re-scrape to refresh the 175 rows.
*Pro:* no new vendor, no new cost beyond Apify credits. *Con:* leaves the corpus without shares, and Apify's field shape has already proven ambiguous once.

**B. Re-pull all metrics for the 175 rows from SocialCrawl.** (recommended)
One call per post returns views, likes, comments and shares from a single source at a single point in time. 175 × 5 credits = **875 credits**; the free tier is 100, so this needs a paid plan.
*Pro:* removes the field-ambiguity class of bug entirely, and delivers shares. *Con:* new vendor dependency and a real cost.

**C. Do nothing about metrics; ship the 175 rows without a performance score.**
*Pro:* free; titles and descriptions are already sound. *Con:* the prior score stays meaningless and the eval harness has nothing to measure — i.e. deliverables 2 and 4 stay blocked.

Under all three, **line 195 must be fixed regardless**, or the next scrape reproduces the defect.

---

## Recommended next steps

1. **Fix `scripts/scrape-instagram.ts:195`** to prefer `videoPlayCount`, and add a comment recording that `videoViewCount` is a different, stricter metric and not a fallback alias. Cheap, and it stops the bug recurring.
2. **Decide between A and B** (above) before any further metric analysis. Re-running the engagement-vs-outlier comparison on the current column would just produce another invalid answer.
3. **Re-run the metric ranking once clean data exists** — with shares available, a share rate becomes a serious contender against creator-relative view outlier, and closer to the client's original intent.
4. **Separately assess the scrape-composition risk.** Quantify how many `excluded_low_views` rejections used a `videoViewCount` figure. If material, a re-scrape of the rejection pool may recover usable videos — relevant to the 175-vs-200 row shortfall.
5. **Rename `corpus_titles.save_rate_estimate`** once a metric is chosen. It will not estimate save rate, and leaving the name invites exactly the misreading that started this investigation.

---

## Verification commands

Reproduce the field disagreement:

```bash
node -e "…fetch apify~instagram-reel-scraper for one handle, print videoViewCount vs videoPlayCount per item…"
```

Reproduce the cross-source comparison (requires `SOCIALCRAWL_API_KEY` in `.env.local`):

```bash
curl -H "x-api-key: $SOCIALCRAWL_API_KEY" \
  "https://www.socialcrawl.dev/v1/instagram/post/stats?url=https://www.instagram.com/p/DYj9jzMiIPV/"
```

Raw evidence retained at `.superpowers/sdd/2026-07-31-burn-in-title-ocr/` and the scratchpad `sc-coverage.json` from this session.
