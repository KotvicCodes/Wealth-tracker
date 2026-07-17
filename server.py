#!/usr/bin/env python3
"""Wealth Tracker server.

Serves the static webapp and proxies the Forbes real-time billionaires API
(the browser can't call forbes.com directly because of CORS). Stdlib only.

Run:  python3 server.py   ->  http://localhost:8000
"""
import gzip
import json
import os
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
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
CACHE_TTL = 10 * 60  # seconds

_cache = {"body": None, "fetched_at": 0.0}
_cache_lock = threading.Lock()

SPARK_POINTS = 40  # downsample intraday history to this many points


def _downsample(values, n):
    if len(values) <= n:
        return values
    step = (len(values) - 1) / (n - 1)
    return [values[round(i * step)] for i in range(n)]


def _trim_person(p):
    history = ((p.get("wealthHistory") or {}).get("lastDay")) or []
    spark = _downsample([round(pt["value"]) for pt in history if "value" in pt], SPARK_POINTS)
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
        "spark": spark,
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


def _fetch_billionaires():
    global _ssl_ctx
    raw = None
    for attempt in range(4):
        try:
            raw = _http_get(FORBES_URL, _ssl_ctx)
            break
        except urllib.error.HTTPError as e:
            if e.code >= 500 and attempt < 3:  # transient CDN hiccup — retry
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
    return {"asOf": int(time.time() * 1000), "count": len(trimmed), "people": trimmed}


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
