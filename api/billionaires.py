"""Vercel serverless function: GET /api/billionaires."""
import gzip
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _forbes  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            body, status = _forbes.get_billionaires_json(), 200
        except Exception as e:  # network/parse failure, tell the client
            body, status = json.dumps({"error": str(e)}).encode(), 502

        if "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body, encoding = gzip.compress(body), "gzip"
        else:
            encoding = None

        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
