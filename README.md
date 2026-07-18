# Wealth Tracker

A simple webapp that tracks returns and does data analysis of the world's richest
people (~3,400 billionaires), using **Forbes' public real-time billionaires API**.

## Run

```sh
python3 server.py
```

Then open http://localhost:8000. No dependencies: Python 3 stdlib only
(Chart.js is loaded from a CDN in the browser).

## What it does

- **Rankings**: all ~3,400 billionaires with net worth, daily, 3-month and
  1-year returns ($ and %), a 5-year trend sparkline, search, country/industry
  filters, column sorting, and a Top 500 scope toggle. Click any row for a
  person detail view with returns across every period and a 2021-to-now
  wealth chart.
- **Performance**: returns over a selectable period (Day, 30D, 90D, YTD, 1Y,
  3Y, 5Y) with aggregate, average and median change, gainer/loser counts,
  best and worst performers, top movers by $ and by %, average return by
  industry and country, a return distribution histogram, and wealth
  trajectories of the current top 8.
- **Analysis**: stat tiles (combined/average/median wealth, today's aggregate
  move), top daily gainers/losers, billionaire counts by country and industry,
  net-worth distribution, wealth-concentration curve, age distribution,
  self-made and gender composition.

## Data notes

- `server.py` proxies `https://www.forbes.com/forbesapi/person/rtb/0/position/true.json`,
  trims the 41 MB payload to the fields the app needs, and caches it for 10 minutes.
- Yearly returns (1Y/3Y/5Y) compare against past annual Forbes lists
  (2021 to 2025), fetched once and cached in `data/annual_<year>.json`. People
  are matched across years by normalized name, so brand-new billionaires show
  no data for years before they appeared.
- 1M and 3M returns use this app's own daily snapshots: each day the server
  fetches fresh data it stores a compact `{name, worth}` entry in
  `data/history.json`, so short-term return history accumulates the more you
  run it. Until ~90 days of snapshots exist, these windows fall back to an
  estimate interpolated between the latest annual list (`archivedWorth`, dated
  by `ARCHIVED_LIST_DATE` in `server.py`) and the live value; estimated numbers
  are marked with `*` in the UI.
