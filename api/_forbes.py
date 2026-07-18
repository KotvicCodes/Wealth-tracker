"""Shared Forbes data logic (stdlib only).

Used by both the local dev server (server.py) and the Vercel serverless
functions (api/billionaires.py, api/history.py, api/cron.py).
"""
import gzip
import json
import os
import re
import ssl
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

# Only the fields the app needs, so the live payload is ~200 KB, not ~41 MB.
_FIELDS = (
    "rank,personName,finalWorth,estWorthPrev,archivedWorth,countryOfCitizenship,"
    "industries,source,gender,birthDate,selfMade,squareImage"
)
FORBES_URL = (
    "https://www.forbes.com/forbesapi/person/rtb/0/position/true.json?fields=" + _FIELDS
)
ANNUAL_URL = (
    "https://www.forbes.com/forbesapi/person/billionaires/{year}/position/true.json"
    "?fields=personName,finalWorth"
)
ANNUAL_YEARS = [2021, 2022, 2023, 2024, 2025]  # the current year comes from archivedWorth
# Approximate snapshot date of the latest annual Forbes billionaires list, which
# is what archivedWorth holds. Used to date that value so the client can build
# temporary short-window (1M/3M) estimates. Update once a year when the list refreshes.
ARCHIVED_LIST_DATE = "2026-03-07"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
CACHE_TTL = 10 * 60  # seconds

_cache = {"body": None, "data": None, "fetched_at": 0.0}
_cache_lock = threading.Lock()


def _default_ssl_context():
    """macOS Pythons often lack CA certs; use certifi when available."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_ssl_ctx = _default_ssl_context()


def _http_get(url, timeout=60):
    global _ssl_ctx
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    )
    try:
        resp = urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx)
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLCertVerificationError):
            # No usable CA bundle. The feed is public read-only data, so an
            # unverified fetch is an acceptable last resort.
            _ssl_ctx = ssl._create_unverified_context()
            resp = urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx)
        else:
            raise
    with resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw


def _norm_name(name):
    """Annual lists have per-year IDs, so people are joined across years by name."""
    name = (name or "").lower()
    name = re.sub(r"\s*&\s*family", "", name)
    return re.sub(r"[^a-z ]", "", name).strip()


def _trim_person(p):
    industries = p.get("industries") or []
    return {
        "rank": p.get("rank"),
        "name": p.get("personName"),
        "worth": p.get("finalWorth"),             # $M
        "prevWorth": p.get("estWorthPrev"),       # $M, previous close
        "archivedWorth": p.get("archivedWorth"),  # $M, last annual list
        "country": p.get("countryOfCitizenship"),
        "industry": industries[0] if industries else None,
        "source": p.get("source"),
        "gender": p.get("gender"),
        "birthDate": p.get("birthDate"),          # ms epoch
        "selfMade": p.get("selfMade"),
        "image": p.get("squareImage"),
    }


_annual = None
_annual_lock = threading.Lock()


def _load_annual():
    """Past annual lists as {year: {normalized name: worth}}.

    Prefers the committed bundle (api/annual.json) so serverless cold starts are
    instant; falls back to fetching live if the bundle is missing.
    """
    global _annual
    with _annual_lock:
        if _annual is not None:
            return _annual
        try:
            with open(os.path.join(HERE, "annual.json")) as f:
                _annual = json.load(f)
                return _annual
        except (OSError, ValueError):
            pass
        maps = {}
        for year in ANNUAL_YEARS:
            try:
                raw = _http_get(ANNUAL_URL.format(year=year))
                people = json.loads(raw)["personList"]["personsLists"]
                maps[str(year)] = {
                    _norm_name(p["personName"]): p["finalWorth"]
                    for p in people if p.get("finalWorth")
                }
            except Exception as e:
                print(f"warning: annual {year} fetch failed: {e}")
        _annual = maps
        return _annual


def _fetch_billionaires():
    raw = None
    for attempt in range(4):
        try:
            raw = _http_get(FORBES_URL)
            break
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < 3:  # transient CDN hiccup, retry
                time.sleep(2)
                continue
            raise
    if raw is None:
        raise RuntimeError("could not fetch Forbes data after retries")
    people = json.loads(raw)["personList"]["personsLists"]
    trimmed = sorted(
        (_trim_person(p) for p in people if p.get("finalWorth")),
        key=lambda x: x["rank"] if x["rank"] is not None else 10**9,
    )
    annual = _load_annual()
    for p in trimmed:
        key = _norm_name(p["name"])
        p["annual"] = {y: worths[key] for y, worths in annual.items() if key in worths}
    return {
        "asOf": int(time.time() * 1000),
        "count": len(trimmed),
        "annualYears": ANNUAL_YEARS,
        "archivedAsOf": ARCHIVED_LIST_DATE,
        "people": trimmed,
    }


def get_billionaires_dict():
    with _cache_lock:
        if _cache["data"] and time.time() - _cache["fetched_at"] < CACHE_TTL:
            return _cache["data"]
    data = _fetch_billionaires()
    body = json.dumps(data, separators=(",", ":")).encode()
    with _cache_lock:
        _cache["data"] = data
        _cache["body"] = body
        _cache["fetched_at"] = time.time()
    return data


def get_billionaires_json():
    get_billionaires_dict()
    return _cache["body"]


def snapshot_entry(data):
    """Compact per-day snapshot used to track returns over time."""
    return {
        "asOf": data["asOf"],
        "people": [[p["name"], p["worth"]] for p in data["people"]],
    }
