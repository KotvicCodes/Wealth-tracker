#!/usr/bin/env python3
"""Wealth Tracker server.

Serves the static webapp and proxies the Forbes real-time billionaires API
(the browser can't call forbes.com directly because of CORS). Stdlib only.

Run:  python3 server.py   ->  http://localhost:8000
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
from datetime import date
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = 8000
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
HISTORY_FILE = os.path.join(DATA_DIR, "history.json")

FORBES_URL = "https://www.forbes.com/forbesapi/person/rtb/0/position/true.json"
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

_cache = {"body": None, "fetched_at": 0.0}
_cache_lock = threading.Lock()

def _trim_person(p):
    industries = p.get("industries") or []
    return {
        "rank": p.get("rank"),
        "name": p.get("personName"),
        "worth": p.get("finalWorth"),          # $M
        "prevWorth": p.get("estWorthPrev"),    # $M, previous close
        "archivedWorth": p.get("archivedWorth"),  # $M, last annual list
        "country": p.get("countryOfCitizenship"),
        "industry": industries[0] if industries else None,
        "source": p.get("source"),
        "gender": p.get("gender"),
        "birthDate": p.get("birthDate"),       # ms epoch
        "selfMade": p.get("selfMade"),
        "image": p.get("squareImage"),
    }


def _default_ssl_context():
    """macOS Pythons often lack CA certs; use certifi when available."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_ssl_ctx = _default_ssl_context()


def _http_get(url, ctx, timeout=90):
    req = urllib.request.Request(
        url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"}
    )
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw


def _norm_name(name):
    """Annual lists have per-year IDs, so people are joined across years by name."""
    name = (name or "").lower()
    name = re.sub(r"\s*&\s*family", "", name)
    return re.sub(r"[^a-z ]", "", name).strip()


_annual_lock = threading.Lock()
_annual_maps = None  # {year: {normalized name: worth $M}}


def _load_annual_lists():
    """Past annual Forbes lists (static data): fetch once, cache on disk forever."""
    global _annual_maps
    with _annual_lock:
        if _annual_maps is not None:
            return _annual_maps
        os.makedirs(DATA_DIR, exist_ok=True)
        maps = {}
        for year in ANNUAL_YEARS:
            cache_file = os.path.join(DATA_DIR, f"annual_{year}.json")
            try:
                with open(cache_file) as f:
                    people = json.load(f)
            except (OSError, ValueError):
                print(f"fetching Forbes {year} annual list…")
                raw = _http_get(ANNUAL_URL.format(year=year), _ssl_ctx)
                people = [
                    {"name": p.get("personName"), "worth": p.get("finalWorth")}
                    for p in json.loads(raw)["personList"]["personsLists"]
                    if p.get("finalWorth")
                ]
                tmp = cache_file + ".tmp"
                with open(tmp, "w") as f:
                    json.dump(people, f)
                os.replace(tmp, cache_file)
            maps[year] = {_norm_name(p["name"]): p["worth"] for p in people}
        _annual_maps = maps
        return maps


def _fetch_billionaires():
    global _ssl_ctx
    raw = None
    for attempt in range(4):
        try:
            raw = _http_get(FORBES_URL, _ssl_ctx)
            break
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < 3:  # transient CDN hiccup – retry
                time.sleep(2)
                continue
            raise
        except urllib.error.URLError as e:
            if attempt < 3 and isinstance(e.reason, ssl.SSLCertVerificationError):
                # No usable CA bundle. The feed is public read-only data, so an
                # unverified fetch is an acceptable last resort.
                print("warning: no usable CA bundle; fetching without certificate verification")
                _ssl_ctx = ssl._create_unverified_context()
                continue
            raise
    if raw is None:
        raise RuntimeError("could not fetch Forbes data after retries")
    payload = json.loads(raw)
    people = payload["personList"]["personsLists"]
    trimmed = sorted(
        (_trim_person(p) for p in people if p.get("finalWorth")),
        key=lambda x: x["rank"] if x["rank"] is not None else 10**9,
    )
    try:
        annual = _load_annual_lists()
    except Exception as e:
        print(f"warning: annual lists unavailable: {e}")
        annual = {}
    for p in trimmed:
        key = _norm_name(p["name"])
        p["annual"] = {
            str(year): worths[key] for year, worths in annual.items() if key in worths
        }
    return {
        "asOf": int(time.time() * 1000),
        "count": len(trimmed),
        "annualYears": ANNUAL_YEARS,
        "archivedAsOf": ARCHIVED_LIST_DATE,
        "people": trimmed,
    }


def _save_snapshot(data):
    """Keep one compact snapshot per calendar day so returns can be tracked over time."""
    os.makedirs(DATA_DIR, exist_ok=True)
    today = date.today().isoformat()
    try:
        with open(HISTORY_FILE) as f:
            history = json.load(f)
    except (OSError, ValueError):
        history = {}
    if today in history:
        return
    history[today] = {
        "asOf": data["asOf"],
        "people": [[p["name"], p["worth"]] for p in data["people"]],
    }
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(history, f)
    os.replace(tmp, HISTORY_FILE)


def get_billionaires_json():
    with _cache_lock:
        if _cache["body"] and time.time() - _cache["fetched_at"] < CACHE_TTL:
            return _cache["body"]
    data = _fetch_billionaires()
    body = json.dumps(data, separators=(",", ":")).encode()
    with _cache_lock:
        _cache["body"] = body
        _cache["fetched_at"] = time.time()
    try:
        _save_snapshot(data)
    except OSError as e:
        print(f"warning: could not save snapshot: {e}")
    return body


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        if self.path == "/api/billionaires":
            try:
                body = get_billionaires_json()
            except Exception as e:  # network/parse failure -> tell the client
                self._send_json(502, json.dumps({"error": str(e)}).encode())
                return
            self._send_json(200, body, compress=True)
        elif self.path == "/api/history":
            try:
                with open(HISTORY_FILE, "rb") as f:
                    self._send_json(200, f.read())
            except OSError:
                self._send_json(200, b"{}")
        else:
            super().do_GET()

    def _send_json(self, status, body, compress=False):
        if compress and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body)
            encoding = "gzip"
        else:
            encoding = None
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}")


if __name__ == "__main__":
    print(f"Wealth Tracker running at http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
