"""Vercel serverless function: GET /api/history."""
import gzip
import os
import sys
from http.server import BaseHTTPRequestHandler

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _storage  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = _storage.read_history_bytes()
        if "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body, encoding = gzip.compress(body), "gzip"
        else:
            encoding = None

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        if encoding:
            self.send_header("Content-Encoding", encoding)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
