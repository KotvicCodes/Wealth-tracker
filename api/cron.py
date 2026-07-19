"""Vercel serverless function: GET /api/cron.

Triggered daily by Vercel Cron (see vercel.json). Fetches the current data and
stores one snapshot for today so 1M/3M returns accumulate real values over time.
Once a week it also refreshes the population reference data for the Your Odds
view. Also callable manually to seed the first snapshot.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _forbes  # noqa: E402
import _reference  # noqa: E402
import _storage  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # If a CRON_SECRET is configured, Vercel Cron sends it as a bearer token.
        secret = os.environ.get("CRON_SECRET")
        if secret and self.headers.get("Authorization") != f"Bearer {secret}":
            self._json(401, {"error": "unauthorized"})
            return
        try:
            data = _forbes.get_billionaires_dict()
            saved = _storage.append_today(_forbes.snapshot_entry(data))
            reference = _reference.refresh_if_stale()  # weekly, no-op otherwise
            self._json(200, {"ok": True, "saved": saved, "count": data["count"],
                             "reference": reference})
        except Exception as e:
            self._json(500, {"ok": False, "error": str(e)})

    def _json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
