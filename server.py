#!/usr/bin/env python3
"""Wealth Tracker local dev server.

Serves the static webapp and the same /api endpoints the Vercel functions expose
(the browser can't call forbes.com directly because of CORS). Stdlib only.

Run:  python3 server.py   ->  http://localhost:8000

On Vercel these endpoints are serverless functions in api/; this server just
reuses the shared logic in api/_forbes.py and api/_storage.py so local and
production behave the same.
"""
import gzip
import json
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8000"))
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(BASE_DIR, "api"))
import _forbes  # noqa: E402
import _reference  # noqa: E402
import _storage  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def do_GET(self):
        if self.path == "/api/billionaires":
            try:
                data = _forbes.get_billionaires_dict()
                _storage.append_today(_forbes.snapshot_entry(data))  # daily snapshot
                _reference.refresh_if_stale()  # local stand-in for the weekly cron
                self._send_json(200, _forbes.get_billionaires_json(), compress=True)
            except Exception as e:  # network/parse failure, tell the client
                self._send_json(502, json.dumps({"error": str(e)}).encode())
        elif self.path == "/api/history":
            self._send_json(200, _storage.read_history_bytes(), compress=True)
        elif self.path == "/api/reference":
            self._send_json(200, _reference.read_reference_bytes(), compress=True)
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
