# Deploying Brewscope — free, click-by-click

Goal: a private `https://…pages.dev` URL your 2–3 teammates log into, data refreshing
itself daily. Cost: **$0**. Time: **~20 min**. You need a GitHub account and a Cloudflare
account (both free).

Nothing here touches a database — the git repo *is* the store, GitHub Actions runs the
sync, Cloudflare Pages serves it.

---

## Step 1 — Put this folder on GitHub (private)

This `coffee-npd-app` folder becomes the **root** of a new repo.

1. On GitHub: **+ (top-right) → New repository**. Name it e.g. `brewscope`. Choose
   **Private**. Do **not** add a README/.gitignore (this folder already has them). **Create**.
2. In a terminal, from inside this folder:

   ```bash
   cd coffee-npd-app
   git init
   git add .
   git commit -m "Brewscope initial"
   git branch -M main
   git remote add origin https://github.com/<YOUR-USER>/brewscope.git
   git push -u origin main
   ```

   > `credentials.json` is git-ignored, so your keys won't be uploaded. The data files in
   > `data/` **are** committed on purpose — that's your accumulated store.

✅ Check: GitHub shows `index.html`, `app.py`, `collector.py`, `static/`, `data/`,
`.github/workflows/sync.yml`.

---

## Step 2 — Give the sync your YouTube key (repo secret)

1. Repo → **Settings → Secrets and variables → Actions → New repository secret**.
2. Name: `YOUTUBE_API_KEY` — Value: your key. **Add secret**.
3. *(Optional, for Reddit)* add `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`,
   `REDDIT_USER_AGENT` the same way.

> Secrets are never visible in the repo or logs. The workflow reads them at run time.

---

## Step 3 — Run the sync once

1. Repo → **Actions** tab. If prompted, click **I understand my workflows, enable them**.
2. Left list → **Brewscope sync** → **Run workflow → Run workflow** (green button).
3. Wait ~2–3 min. A green check = it collected data and committed it (you'll see a new
   "Brewscope sync …" commit). This also proves the daily schedule will work.

✅ Check: the repo's `data/dataset.json` has a fresh commit timestamp.

---

## Step 4 — Host it on Cloudflare Pages (free)

1. <https://dash.cloudflare.com> → **Workers & Pages → Create → Pages →
   Connect to Git**. Authorise GitHub, pick the `brewscope` repo.
2. Build settings:
   - **Framework preset:** `None`
   - **Build command:** *(leave empty)*
   - **Build output directory:** `/`
3. **Save and Deploy**. After ~1 min you get **`https://brewscope-xxxx.pages.dev`**.

Open it — the console loads. From now on, every time the sync commits new data, Pages
redeploys automatically (usually within a minute).

✅ Check: the page shows data and the "Last sync" time in the bottom-left rail.

---

## Step 5 — Lock it to your team (free login)

Right now the URL is public-but-unguessable. To require a login:

1. Cloudflare dash → **Zero Trust** (set up the free plan if first time — it asks for a team
   name; no card needed for the free tier).
2. **Access → Applications → Add an application → Self-hosted**.
   - **Application name:** Brewscope
   - **Application domain:** your `brewscope-xxxx.pages.dev`
3. **Next → Add policy**:
   - **Policy name:** Team
   - **Action:** Allow
   - **Include → Emails** → add each teammate's email (and yours).
4. **Next → Add application**.

Now visiting the URL prompts for an email → a one-time code → access. Up to 50 users free.

---

## Step 6 (optional) — In-app "Refresh" button

By default data refreshes daily on its own. To let people trigger a refresh from the app:

1. Edit `index.html`, set:
   ```js
   window.BREWSCOPE_ACTIONS_URL = "https://github.com/<YOUR-USER>/brewscope/actions/workflows/sync.yml";
   ```
2. Commit & push. The top-right **Sync** button becomes **Refresh** — it opens that page,
   where they click **Run workflow**. (A true one-click in-app sync needs a paid server; see
   `render.yaml`.)

---

## Changing how often it syncs

Edit the `cron` in [`.github/workflows/sync.yml`](.github/workflows/sync.yml):

```yaml
    - cron: "0 6 * * *"      # daily 06:00 UTC  (default)
    # - cron: "0 */12 * * *" # every 12 hours
    # - cron: "0 6 * * 1"    # weekly, Mondays
```

Push the change; GitHub picks up the new schedule.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Actions run fails on "Run sync" | Usually a missing/invalid `YOUTUBE_API_KEY` secret (Step 2). The log shows a YouTube error message. |
| "No data yet" on the site | The sync hasn't committed yet — run it (Step 3), wait for Pages to redeploy. |
| Site shows old data | Pages redeploys on each data commit; hard-refresh (Ctrl-F5). `_headers` already disables caching for `dataset.json`. |
| Everyone can see it | You skipped Step 5 (Cloudflare Access), or the Access app domain doesn't exactly match the `pages.dev` URL. |
| YouTube quota exhausted | Expected some days — Google News still fills in. It accumulates; next day recovers. |

---

## What costs money? Nothing.

- **GitHub** private repo + Actions: free (you'll use ~30 of 2,000 free minutes/month).
- **Cloudflare Pages** + **Access** (≤50 users): free.
- Only the **optional** Render path (`render.yaml`) costs $7/mo, and only if you want the
  always-on live Sync button instead of scheduled refresh.
