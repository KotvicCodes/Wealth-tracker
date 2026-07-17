# Wealth Tracker

A simple webapp that tracks returns and does data analysis of the world's richest
people (~3,400 billionaires), using **Forbes' public real-time billionaires API**.

> Bloomberg's Billionaires Index was the original target, but Bloomberg blocks all
> non-browser requests (HTTP 403), so live data from it isn't possible. Forbes
> exposes the equivalent data (updated continuously during trading hours) via an
> open JSON endpoint, which this app uses instead.

## Run

```sh
python3 server.py
```

Then open http://localhost:8000. No dependencies: Python 3 stdlib only
(Chart.js is loaded from a CDN in the browser).

## What it does

- **Rankings**: all ~3,400 billionaires with net worth, daily, YTD and 1-year
  returns ($ and %), intraday sparkline, search, country/industry filters,
  column sorting, and a Top 500 scope toggle. Click any row for a person
  detail view with returns across every period and a 2021-to-now wealth chart.
- **Performance**: returns over a selectable period (Day, 30D, 90D, YTD, 1Y,
  3Y, 5Y) with aggregate change, gainer/loser counts, best and worst
  performers, top movers by $ and by %, a return distribution histogram, and
  wealth trajectories of the current top 8.
- **Analysis**: stat tiles (combined/average/median wealth, today's aggregate
  move), top daily gainers/losers, wealth by country and industry, net-worth
  distribution, wealth-concentration curve, age distribution, self-made and
  gender composition.

## Data notes

- `server.py` proxies `https://www.forbes.com/forbesapi/person/rtb/0/position/true.json`,
  trims the 41 MB payload to the fields the app needs, and caches it for 10 minutes.
- Yearly returns (1Y/3Y/5Y) compare against past annual Forbes lists
  (2021 to 2025), fetched once and cached in `data/annual_<year>.json`. People
  are matched across years by normalized name, so brand-new billionaires show
  no data for years before they appeared.
- 30D and 90D returns use this app's own daily snapshots: each day the server
  fetches fresh data it stores a compact `{name, worth}` entry in
  `data/history.json`, so short-term return history accumulates the more you
  run it.
