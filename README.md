# ☕ Brewscope — Coffee NPD Console

An enterprise-style web console for the insights/NPD team to see **what coffee
drinkers in the US, UK and India are talking about** — by **coffee format** and
**brand** — with product-launch detection, **SARIMA forecasting**, and an
**Impact Factor** to prioritise. Built for the discovery phase of NPD.

## Run it

```
pip install -r requirements.txt
python app.py            (or run.bat)
```
Open **http://127.0.0.1:5000**, then click **Sync** (top-right).

> If the page looks stale after a change, clear any old server first:
> `Get-Process | ? { $_.ProcessName -like "python*" } | Stop-Process -Force`

## Markets

`US + UK` · `US` · `UK` · `Canada` — toggle in the top bar. Canada is a **separate
market**, never merged into US+UK. The whole console re-slices instantly, including
the data-window date range. (Edit `config.json → regions` / `region_groups` to change.)

## Data sources (all free)

| Source | Key needed? | Notes |
|---|---|---|
| **YouTube** | Free API key | Per-market video search; ~3k of 10k daily quota per full sync |
| **Google News** | None | Per-market news RSS — no quota, always available |
| **Google Trends** | None | Search-interest signal per format (best-effort; Google rate-limits) |
| **Coffee press** | None | Sprudge, Daily Coffee News, Perfect Daily Grind |
| **Reddit** | Free API key (optional) | r/Coffee, r/espresso, r/cafe, r/barista + engagement |

Add keys in `credentials.json` (copy `credentials.example.json`). Reddit setup:
reddit.com/prefs/apps → create a **script** app → paste client id/secret. Each source
degrades gracefully — a missing key or rate limit just gets skipped.

## Views

- **Overview** — exec summary, KPIs (incl. *our share of voice*), trend leaders, SoV, sentiment.
- **Coffee Types** — every format with sentiment, 12-wk trend and momentum.
- **Perception Radar** — *brand-agnostic*: how coffee **itself** is perceived across 8 lenses
  (Health, Side-effects, Energy, Taste, Sustainability, Price, Convenience, Culture). A radar of
  each lens's share of opinionated conversation (dot colour = sentiment), a **Coffee Perception
  Index (0–100)**, most-loved lens vs. biggest concern, sentiment-per-theme bars, and real
  mentions. Slices by market like everything else.
- **Brands** — knowledge-base share of voice + an **Emerging brands** list (auto-detected,
  not yet in the knowledge base).
- **Forecast & Impact** — SARIMA projection of each format's volume for the next N weeks,
  ranked by **Impact Factor (0–100)** = projected momentum × reach × sentiment.
- **Our Portfolio** — Tata Consumer Products brands, **market-aware** (Eight O'Clock → US/UK;
  Tata Coffee Grand / Sonnets / Tata Coffee → India).
- **Launch Radar** — detected launches with brand, format, date and audience reaction.

## How brands work (not hand-maintained)

- **Knowledge base** (`brands_reference.json`) — a market-tagged list of real coffee
  brands used for clean, precise share-of-voice. Extend this file anytime; you never
  edit code or `config.json` for brands.
- **Auto-discovery** — surfaces *new* brand-like names from the conversation that aren't
  in the knowledge base, in the Brands view's "Emerging brands" section, for review.
- Your portfolio brands are declared (market-aware) in `config.json → our_brands`.

## Data accumulation

Each sync **appends** to a persistent store (`data/store.json`), deduplicated by
video id, so the dataset **grows every sync** and the time series gets longer —
which steadily improves the SARIMA forecasts. `data/dataset.json` (what the browser
reads) is rebuilt from the store on each sync.

- Rebuild reports/metrics from the store **without** hitting the API:
  `python collector.py --reprocess`

## Deploy (live, multi-user) — Render

Brewscope runs as **one process with many threads** (via `waitress`) — perfect for a
small team. No database: a few hundred KB of JSON on a **persistent disk** is the only
storage needed. Multiple people reading is trivial; a built-in lock stops two syncs
overlapping; writes are atomic (temp-file + rename) so a reader never catches a half file.

**Steps:**

1. Push this `coffee-npd-app` folder to a GitHub repo (it becomes the repo root).
2. Render → **New + → Blueprint** → pick the repo. It reads [`render.yaml`](render.yaml)
   (Starter plan + a 1 GB disk mounted at `/var/data`).
3. Set two secrets in the Render dashboard:
   - `BREWSCOPE_PASSWORD` — the shared team password (username defaults to `team`).
   - `YOUTUBE_API_KEY` — your YouTube Data API key.
4. Deploy. You get an `https://brewscope-xxxx.onrender.com` URL. Share it + the password
   with your 2–3 teammates. Click **Sync** once to populate the disk.

**Notes:**
- The **Starter plan ($7/mo) is required** — the free plan has no persistent disk, so the
  accumulation store would reset on every deploy. Storage size isn't the reason ($/mo buys
  the disk, not space).
- Env vars that control the app: `BREWSCOPE_PASSWORD`, `BREWSCOPE_USER`, `BREWSCOPE_DATA`
  (disk path), `HOST`, `PORT` (Render injects `PORT`), `YOUTUBE_API_KEY`, optional Reddit keys.
- To **seed** the cloud with your current local data, copy your local `data/store.json` onto
  the Render disk (or just run Sync a few times — it accumulates).
- Locally, none of this applies: `python app.py` still runs open on `127.0.0.1:5000`
  (auth off unless you set `BREWSCOPE_PASSWORD`).

## Notes

- **YouTube quota**: each full sync (10 queries × 3 markets) uses ~3k of the 10k/day
  free quota. If quota is exhausted, a sync keeps your previous data (no wipe) — just
  sync again after the daily reset.
- **Forecast / Impact / momentum** are transparent statistical heuristics — a prioritised
  watch list, not a guaranteed forecast.
- **Instagram / TikTok** excluded by design (no stable public API).
