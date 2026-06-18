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

## Deploy (live, multi-user) — 100% free

> **Just want the steps?** Follow [`DEPLOY.md`](DEPLOY.md) — exact screens and buttons, ~20 min.

No server and no database. The site is **static files** + a **committed `dataset.json`**;
**GitHub Actions** runs the sync on a schedule and commits the refreshed data back (the git
repo *is* the persistent store — the data is < 1 MB). A static host serves it with free TLS
and **never sleeps**.

```
GitHub Actions (free cron) ── runs collector.py ──► commits data/*.json to the repo
                                                          │
Cloudflare Pages (free, TLS) ◄──── auto-deploys ─────────┘  serves index.html + app.js + data
   └─ Cloudflare Access = free email login for up to 50 users
```

**1 — Push to GitHub.** Push this `coffee-npd-app` folder to a repo (it becomes the repo
root). It can stay **private**. The included files do the rest:
- [`.github/workflows/sync.yml`](.github/workflows/sync.yml) — the scheduled + on-demand sync.
- [`index.html`](index.html) — the static entry point (`app.js` runs in static mode).
- [`_headers`](_headers) — stops Cloudflare caching the daily data file.

**2 — Add the API key as a repo secret.** Repo → Settings → Secrets and variables → Actions →
**New repository secret**: `YOUTUBE_API_KEY` (and optionally `REDDIT_CLIENT_ID` /
`REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT`). Then run the workflow once: Actions tab →
**Brewscope sync → Run workflow**. It commits fresh data.

**3 — Host on Cloudflare Pages (free).** dash.cloudflare.com → Workers & Pages → **Create →
Pages → Connect to Git** → pick the repo. Framework preset **None**, build command **(empty)**,
output directory **/**. Deploy → you get `https://brewscope-xxxx.pages.dev`. Every time the
Action commits new data, Pages redeploys automatically.

**4 — Lock it down (free).** Cloudflare → **Zero Trust → Access → Applications → Add a
self-hosted app** for your `pages.dev` URL, policy = *Emails* → add your 2–3 teammates.
Free for up to 50 users. They sign in by email code; nobody else can view.

**5 — Enable the in-app Refresh button (optional).** In [`index.html`](index.html) set
`window.BREWSCOPE_ACTIONS_URL` to your workflow URL
(`https://github.com/<you>/<repo>/actions/workflows/sync.yml`). The **Sync** button becomes a
**Refresh** link that opens the workflow's *Run workflow* page.

**Notes / trade-offs:**
- **No instant in-app Sync** — data refreshes on the schedule in `sync.yml` (default daily,
  06:00 UTC; edit the `cron`) plus the manual *Run workflow* button. For a trend tool this is
  usually better — it accumulates automatically with no one clicking.
- GitHub Pages works too, but the free tier requires a **public** repo and has no built-in
  login. Cloudflare Pages + Access keeps the repo private and gives free auth.
- Want a **paid but always-dynamic** alternative with a live Sync button? See
  [`render.yaml`](render.yaml) — Render Starter ($7/mo) runs `app.py` (waitress + a persistent
  disk). Same code; `app.py` already reads `PORT`/`HOST`/`BREWSCOPE_PASSWORD`/`BREWSCOPE_DATA`.

## Notes

- **YouTube quota**: each full sync (10 queries × 3 markets) uses ~3k of the 10k/day
  free quota. If quota is exhausted, a sync keeps your previous data (no wipe) — just
  sync again after the daily reset.
- **Forecast / Impact / momentum** are transparent statistical heuristics — a prioritised
  watch list, not a guaranteed forecast.
- **Instagram / TikTok** excluded by design (no stable public API).
