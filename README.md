# Wealth Tracker

A simple webapp that tracks returns and does data analysis of the world's richest
people (~3,400 billionaires), using **Forbes' public real-time billionaires API**.

## Run locally

```sh
python3 server.py
```

Then open http://localhost:8000. No install step: Python 3 stdlib only
(Chart.js is loaded from a CDN in the browser). The `vercel_blob` package in
`requirements.txt` is only used by the deployed site, not local dev.

## Deploy to Vercel

The backend runs as serverless functions in `api/` and the rest is static, so
the whole thing fits Vercel's free (Hobby) tier.

1. Push this folder to a Git repo and import it in Vercel (or run `vercel` from
   here with the CLI). No framework preset needed; the defaults work.
2. Add **Blob** storage: Vercel dashboard, Storage, Create Blob store, and
   connect it to the project. That sets the `BLOB_READ_WRITE_TOKEN` env var,
   which switches snapshot storage from the local filesystem to Blob.
3. (Optional) Set a `CRON_SECRET` env var to lock down the cron endpoint.
4. Deploy. The daily cron in `vercel.json` calls `/api/cron` at 22:00 UTC to
   store one snapshot per day. To seed the first snapshot immediately, open
   `/api/cron` once (or wait for the first cron run).

Routes: `/` serves the app, `/api/billionaires` is the live data proxy,
`/api/history` returns the accumulated snapshots, `/api/cron` writes today's,
`/api/reference` returns the weekly-refreshed population figures.

## What it does

- **Rankings**: all ~3,400 billionaires with net worth, daily, 3-month and
  1-year returns ($ and %), a 5-year trend sparkline, search, country/industry
  filters, column sorting, and a Top 500 scope toggle. Click any row for a
  person detail view with returns across every period and a 2021-to-now
  wealth chart.
- **Performance**: returns over a selectable period (Day, 1M, 3M, YTD, 1Y,
  3Y, 5Y) with aggregate, average and median change, gainer/loser counts,
  best and worst performers, top movers by $ and by %, average return by
  industry and country, a return distribution histogram, and wealth
  trajectories of the current top 8.
- **Analysis**: stat tiles (combined/average/median wealth, today's aggregate
  move, $100B+ club size, top-10 share, Gini coefficient, median age), top
  daily gainers/losers, billionaire counts and combined wealth by country and
  industry, net-worth distribution, wealth-concentration curve, combined
  wealth of the current list over time, age distribution, average net worth
  by age, self-made and gender composition.
- **Your Odds**: pick a country, industry and gender and get a tongue-in-cheek
  estimate of the chance that a person with that profile is on today's list,
  with a factor-by-factor multiplier breakdown vs the average person. Uses
  rough embedded population and workforce figures and assumes the factors are
  independent; the page carries a disclaimer saying exactly that.
  The Performance period selection is remembered across visits (defaults to 1Y).

## Architecture

- `api/_forbes.py` holds the shared data logic; `server.py` (local) and the
  serverless functions in `api/` (`billionaires.py`, `history.py`, `cron.py`)
  both use it, so local and production behave the same.
- The live proxy requests only the fields the app needs, so the payload is
  ~200 KB instead of ~41 MB, and it is cached in memory for 10 minutes.

## Data notes

- Yearly returns (1Y/3Y/5Y) compare against past annual Forbes lists
  (2021 to 2025), bundled as `api/annual.json` so cold starts are instant.
  People are matched across years by normalized name, so brand-new billionaires
  show no data for years before they appeared.
- 1M and 3M returns use this app's own daily snapshots (`api/_storage.py`):
  local dev writes them to `data/history.json`; on Vercel they go to Blob,
  written by the daily cron. Until ~90 days of snapshots exist, these windows
  fall back to an estimate interpolated between the latest annual list
  (`archivedWorth`, dated by `ARCHIVED_LIST_DATE` in `api/_forbes.py`) and the
  live value; estimated numbers are marked with `*` in the UI.

## Zero-maintenance design

The site is meant to keep itself correct without anyone touching it:

- The annual-list years advance automatically each April
  (`_latest_list_year()` in `api/_forbes.py`): the newest past list is fetched
  once, cached to storage as `annual_extra.json`, and the frontend re-anchors
  its 1Y/3Y/5Y periods and year axes to whatever years the API serves.
- Once a week the daily cron refreshes working-age population figures
  (per country and worldwide) from the World Bank API into `reference.json`
  (`api/_reference.py`); the Your Odds view prefers them over its bundled
  fallback estimates. Industry workforce figures stay static on purpose: the
  odds math only uses their ratios (uniform growth cancels out) and no public
  API reports workforce by Forbes' industry categories.
- 1M/3M returns upgrade themselves from estimates to measured values as daily
  snapshots accumulate.

## Dependency updates

Dependabot checks Python dependencies and GitHub Actions every Monday at
09:00 UTC and opens up to three version-update pull requests per ecosystem.
Updates require review and merging; they are not applied automatically. Dependabot alerts and security updates are also
enabled in the repository settings; security fixes run separately from this
weekly schedule.

The Blob SDK is pinned to `0.4.2`, which supports the `vercel_blob` API used by
`api/_storage.py`. Version `0.5.0` changes the import path and API, so upgrading
requires adapting the storage integration first. Chart.js is loaded directly
from a CDN in `index.html` and is outside Dependabot's coverage.

`requirements.in` declares the direct dependency; the generated
`requirements.txt` locks every direct and indirect dependency with artifact
hashes. Dependabot updates the pins and hashes together. For manual changes,
edit `requirements.in` and regenerate with `pip-tools`:

```sh
pip-compile --generate-hashes --output-file=requirements.txt requirements.in
```

The dependency-check workflow installs only hash-verified wheels and tests
storage compatibility on Python 3.12 and 3.14. It runs the installed Blob SDK
against fake HTTP responses, without credentials or access to real storage.
The workflow has read-only repository permissions, and checkout credentials
are not persisted. Run the same checks locally with:

```sh
python3 -m pip install --require-hashes --only-binary=:all: -r requirements.txt
python3 -m unittest discover -s tests -v
```

For Vercel previews, keep the production `BLOB_READ_WRITE_TOKEN` scoped to
Production. If previews need persistent storage, connect a separate Blob
store to Preview. Scope `CRON_SECRET` separately as well. A runtime check in
application code cannot protect a token already available during a preview
build or to an installed dependency.
