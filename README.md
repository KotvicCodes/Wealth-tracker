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
`/api/history` returns the accumulated snapshots, `/api/cron` writes today's.

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
  move), top daily gainers/losers, billionaire counts by country and industry,
  net-worth distribution, wealth-concentration curve, age distribution,
  self-made and gender composition.

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
