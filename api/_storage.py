"""Daily snapshot history storage (stdlib only).

Two backends, chosen at runtime:
- Vercel Blob, when BLOB_READ_WRITE_TOKEN is set (the deployed site).
- Local filesystem (data/history.json), otherwise (local dev).

Either way the shape is {date: {"asOf": ms, "people": [[name, worth], ...]}} and
only one entry per calendar day is kept, capped to a recent window so the blob
and the /api/history response stay small.
"""
import json
import os
import urllib.request
from datetime import date, datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(HERE)
HISTORY_FILE = os.path.join(REPO_ROOT, "data", "history.json")
BLOB_NAME = "history.json"
KEEP_DAYS = 130  # enough to cover the 90-day (3M) window with margin


def _using_blob():
    return bool(os.environ.get("BLOB_READ_WRITE_TOKEN"))


# ---------- Vercel Blob backend (official vercel_blob SDK) ----------
# Imported lazily so local dev never needs the dependency. The SDK reads the
# BLOB_READ_WRITE_TOKEN env var itself.
def _blob_read():
    import vercel_blob
    res = vercel_blob.list({"prefix": BLOB_NAME, "limit": "1"})
    for b in res.get("blobs", []):
        if b.get("pathname") == BLOB_NAME:
            url = b.get("downloadUrl") or b.get("url")
            with urllib.request.urlopen(url, timeout=15) as resp:
                return json.loads(resp.read())
    return {}


def _blob_write(history):
    import vercel_blob
    body = json.dumps(history, separators=(",", ":")).encode()
    vercel_blob.put(BLOB_NAME, body, {
        "addRandomSuffix": "false",
        "allowOverwrite": "true",
        "contentType": "application/json",
    })


# ---------- filesystem backend ----------
def _fs_read():
    try:
        with open(HISTORY_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _fs_write(history):
    os.makedirs(os.path.dirname(HISTORY_FILE), exist_ok=True)
    tmp = HISTORY_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(history, f)
    os.replace(tmp, HISTORY_FILE)


# ---------- public API ----------
def _read():
    return _blob_read() if _using_blob() else _fs_read()


def _write(history):
    (_blob_write if _using_blob() else _fs_write)(history)


def _prune(history):
    cutoff = (datetime.now(timezone.utc).timestamp() - KEEP_DAYS * 86400) * 1000
    return {d: v for d, v in history.items() if (v.get("asOf") or 0) >= cutoff}


def read_history_bytes():
    try:
        return json.dumps(_read(), separators=(",", ":")).encode()
    except Exception as e:
        print(f"warning: could not read history: {e}")
        return b"{}"


def append_today(entry):
    """Add today's snapshot if not already present; best-effort."""
    today = date.today().isoformat()
    try:
        history = _read()
        if today in history:
            return False
        history[today] = entry
        _write(_prune(history))
        return True
    except Exception as e:
        print(f"warning: could not save snapshot: {e}")
        return False
