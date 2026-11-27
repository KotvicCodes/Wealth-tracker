# Wealth Tracker

A simple webapp that tracks returns and does data analysis of the world's richest
people (~3,400 billionaires), using **Forbes' public real-time billionaires API**.

## Run locally

Requires Node.js 26 (`^26.0.0`) and npm.

```sh
npm ci
npm run dev
```

Open http://localhost:8000 (override the port with `PORT`). The TypeScript
server uses Vite for browser modules and hot reload, and shares its API handlers
with Vercel. Without `BLOB_READ_WRITE_TOKEN`, snapshots and reference data are
stored in `data/`. Existing JSON files work without conversion.

For a production build and local smoke test:

```sh
npm run build
npm start
```

## Deploy to Vercel

1. Import this repository into Vercel with the Vite preset and Node.js 26.
   `vercel.json` builds the browser app into `dist/`; Vercel builds the TypeScript
   functions in `api/` separately. The annual-list JSON is imported by the API
   and bundled with its functions.
2. Connect a **public Blob** store to set `BLOB_READ_WRITE_TOKEN`. Existing public
   stores and the paths `history.json`, `reference.json`, and `annual_extra.json`
   remain compatible. Without a token, storage falls back to local files;
   Vercel deployments need Blob for persistence.
3. Optionally configure `CRON_SECRET`. When set, cron requests must send
   `Authorization: Bearer <CRON_SECRET>`.
4. Deploy. The daily cron calls `/api/cron` at 22:00 UTC. Call it manually
   (with the authorization header when configured) to seed the first snapshot.

Routes: `/` serves the app, `/api/billionaires` proxies the live list,
`/api/history` returns snapshots, `/api/cron` writes today's snapshot and
refreshes population figures weekly, and `/api/reference` returns those figures.
The local server also saves snapshots and refreshes reference data when loading
the live list, so local history builds without a scheduler.

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

- `app.ts` is a framework-free TypeScript frontend; Vite bundles Chart.js and
  CSS. `shared/types.ts` defines the API, snapshot, and reference-data contracts.
- `lib/` holds Forbes fetching, storage, population refreshes, and HTTP handlers.
  `server.ts` and the TypeScript functions in `api/` use the same implementation.
- The live proxy requests only the fields the app needs, so the payload is
  ~200 KB instead of ~41 MB, and it is cached in memory for 10 minutes.

## Data notes

- Yearly returns (1Y/3Y/5Y) compare against past annual Forbes lists
  (2021 to 2025), bundled as `api/annual.json` so cold starts are instant.
  People are matched across years by normalized name, so brand-new billionaires
  show no data for years before they appeared.
- 1M and 3M returns use this app's own daily snapshots (`lib/storage.ts`):
  local dev writes them to `data/history.json`; on Vercel they go to Blob,
  written by the daily cron. Until ~90 days of snapshots exist, these windows
  fall back to an estimate interpolated between the latest annual list
  (`archivedWorth`, dated by `archivedAsOf` in `lib/forbes.ts`) and the
  live value; estimated numbers are marked with `*` in the UI.

## Zero-maintenance design

The site is meant to keep itself correct without anyone touching it:

- The annual-list years advance automatically each April
  (`latestListYear()` in `lib/forbes.ts`): the newest past list is fetched
  once, cached to storage as `annual_extra.json`, and the frontend re-anchors
  its 1Y/3Y/5Y periods and year axes to whatever years the API serves.
- Once a week the daily cron refreshes working-age population figures
  (per country and worldwide) from the World Bank API into `reference.json`
  (`lib/reference.ts`); the Your Odds view prefers them over its bundled
  fallback estimates. Industry workforce figures stay static on purpose: the
  odds math only uses their ratios (uniform growth cancels out) and no public
  API reports workforce by Forbes' industry categories.
- 1M/3M returns upgrade themselves from estimates to measured values as daily
  snapshots accumulate.

## Validation and dependencies

```sh
npm test
npm run build
```

The build runs strict TypeScript checking before producing the browser bundle.
Tests cover Forbes caching and annual joins, API errors and cron authorization,
local snapshot retention, the installed Blob SDK with mocked HTTP, World Bank
refreshes, and frontend interactions with fixture data. They use temporary
storage and never need production credentials or call the live data services.

CI runs the tests and build on Node.js 26. `package-lock.json` locks direct and
transitive dependencies, including Chart.js. Dependabot checks npm packages and
GitHub Actions weekly; updates require review and merging.

Keep production `BLOB_READ_WRITE_TOKEN` and `CRON_SECRET` scoped to Production
in Vercel. Connect a separate Blob store if previews need persistent storage.
