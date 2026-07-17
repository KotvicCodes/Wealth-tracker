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

Then open http://localhost:8000. No dependencies — Python 3 stdlib only
(Chart.js is loaded from a CDN in the browser).

## What it does

- **Rankings** — all ~3,400 billionaires with net worth, daily return ($ and %),
  YTD return vs. the last annual Forbes list, intraday sparkline, search,
  country/industry filters, column sorting, and a Top 500 scope toggle.
- **Analysis** — stat tiles (combined/average/median wealth, today's aggregate
  move), top daily gainers/losers, wealth by country and industry, net-worth
  distribution, wealth-concentration curve, age distribution, self-made and
  gender composition.

## Data notes

- `server.py` proxies `https://www.forbes.com/forbesapi/person/rtb/0/position/true.json`,
  trims the 41 MB payload to the fields the app needs, and caches it for 10 minutes.
- Each day the server fetches fresh data, it stores a compact `{name, worth}`
  snapshot in `data/history.json` (one entry per calendar day), so long-run return
  history accumulates the more you use it.
