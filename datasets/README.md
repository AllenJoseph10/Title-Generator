# William Wade Title Dataset

## How to fill `william-wade-titles.csv`

Open in Excel, Numbers, or Google Sheets. Each row = one published short-form video.

### Required columns (the corpus is only as good as these)

| Column | What goes here | Example |
|---|---|---|
| `video_id` | Just a counter — 1, 2, 3… | `47` |
| `date_posted` | YYYY-MM-DD | `2025-09-14` |
| `platform` | `tiktok`, `reels`, `shorts`, or `youtube` | `tiktok` |
| `creator_handle` | `william_j_wade` for his own, or other handles for adjacent creators | `william_j_wade` |
| `video_url` | Direct link so we can re-find it | `https://www.tiktok.com/@william_j_wade/video/...` |
| `burned_in_title` | **The text overlay on the video itself.** Not the caption — the words burned into the video. | `The one watch every man should own before 30` |
| `views` | Final view count | `125000` |
| `likes` | Likes / hearts | `8400` |
| `comments` | Comment count | `210` |
| `shares` | Shares / sends | `1100` |
| `saves` | **The most valuable column.** From his analytics dashboard (it's not public). | `3200` |
| `duration_sec` | Length in seconds | `28` |

### Optional / leave blank

| Column | Notes |
|---|---|
| `caption` | The post caption (under the video). Useful but not critical. |
| `niche` | Default `luxury-menswear`. Change if a video is more lifestyle/finance. |
| `hook_family` | **Leave blank.** The importer auto-classifies into one of: `relatable_pov`, `setup_trivial_reveal`, `listicle_reveal`, `reaction_humblebrag`, `transformation_tease` (see `lib/hooks/taxonomy.ts`). |
| `notes` | Anything weird — collab post, sponsored, format experiment, etc. `partial_reveal` is set automatically when the burned-in title animated in rather than appearing complete. |
| `visual_description` | **Auto-generated.** A short factual description of what the video shows, produced by `npm run describe:videos`. Do not fill in by hand — it must come from the same vision prompt the app uses at query time, or retrieval degrades. |
| `title_template` | **Auto-generated.** Produced by `scripts/lib/title-template.ts` from `burned_in_title`. Bare numerals that quantify delivered content (e.g. "outfits", "ways", "tips") are replaced with `{N}`; everything else — prices, years, ranks, durations, percentages — is left alone. Do not hand-edit. Exists so the corpus can be matched on hook pattern (e.g. `listicle_reveal`'s "{N} Old Money Outfits Every Man Needs") without a retrieved example's specific quantity leaking into a new title. `burned_in_title` remains the verbatim source of truth; this column is a derived view, never the other way around. |

### Targets

- **First 50 rows:** William's top-performing videos from the last 12 months (highest saves first)
- **Next 50 rows:** William's *flops* — videos that under-performed. The model learns as much from "don't do this" as "do this."
- **Then 100–200 rows:** adjacent creators (Magnus Ronning, Justus Hansen, Carl Thompson, Daniel Simmons, anyone in classic menswear/sartorial space)

500 real rows is the goal. 200 is the floor for the prior to mean anything.

### When done

Drop the filled file back into `datasets/`. I'll run an import script that:
1. Embeds every title with OpenAI (cost: ~$0.02 for 500 rows)
2. Auto-classifies hook_family using the existing taxonomy
3. Computes save_rate = saves / views
4. Inserts into `corpus_titles` table

Then the prior score becomes meaningful and the eval harness can actually compare model outputs to what really worked.
