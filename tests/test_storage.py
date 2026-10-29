"""Exercise the installed Blob SDK without credentials or network access."""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from requests import Response

from api import _storage


def json_response(payload):
    """Build a successful SDK HTTP response from a JSON payload."""
    response = Response()
    response.status_code = 200
    response._content = json.dumps(payload).encode()
    response.headers["Content-Type"] = "application/json"
    return response


class StorageCompatibilityTests(unittest.TestCase):
    def setUp(self):
        """Use a fake token and reject accidental socket connections."""
        environment = patch.dict(os.environ, {"BLOB_READ_WRITE_TOKEN": "test-only-token"})
        environment.start()
        self.addCleanup(environment.stop)
        network = patch("socket.socket.connect", side_effect=AssertionError(
            "Network access is disabled in storage tests"
        ))
        network.start()
        self.addCleanup(network.stop)

    def test_blob_write_preserves_json_and_overwrites_the_same_path(self):
        """Check the real SDK produces a stable, overwritable JSON upload."""
        payload = {"example": {"asOf": 123, "people": [["Example", 100]]}}
        with patch("requests.sessions.Session.request", autospec=True,
                   return_value=json_response({"pathname": "history.json"})) as request:
            _storage.write_json("history.json", payload)

        request.assert_called_once()
        _, method, url = request.call_args.args
        self.assertEqual(method, "PUT")
        self.assertTrue(url.endswith("/?pathname=history.json"))
        options = request.call_args.kwargs
        self.assertEqual(json.loads(options["data"]), payload)
        self.assertEqual(options["headers"]["authorization"], "Bearer test-only-token")
        self.assertEqual(options["headers"]["x-content-type"], "application/json")
        self.assertEqual(options["headers"]["x-allow-overwrite"], "1")
        self.assertNotEqual(options["headers"].get("x-add-random-suffix"), "1")

    def test_blob_read_downloads_the_matching_document(self):
        """Check both supported download URL fields with the real list API."""
        payload = {"example": {"population": 100}}
        for url_key in ("downloadUrl", "url"):
            with self.subTest(url_key=url_key):
                url = "https://example.invalid/reference.json"
                listing = {"blobs": [
                    {"pathname": "reference.json.backup", "url": "https://example.invalid/backup"},
                    {"pathname": "reference.json", url_key: url},
                ]}
                with patch("requests.sessions.Session.request", autospec=True,
                           return_value=json_response(listing)) as request, patch(
                               "api._storage.urllib.request.urlopen",
                               return_value=io.BytesIO(json.dumps(payload).encode())
                           ) as download:
                    self.assertEqual(_storage.read_json("reference.json"), payload)

                request.assert_called_once()
                self.assertEqual(request.call_args.args[1], "GET")
                self.assertEqual(request.call_args.kwargs["params"],
                                 {"prefix": "reference.json", "limit": "1"})
                download.assert_called_once_with(url, timeout=15)

    def test_missing_blob_returns_an_empty_document_without_downloading(self):
        """Keep a missing document empty without attempting a download."""
        with patch("requests.sessions.Session.request", autospec=True,
                   return_value=json_response({"blobs": []})), patch(
                       "api._storage.urllib.request.urlopen"
                   ) as download:
            self.assertEqual(_storage.read_json("history.json"), {})
        download.assert_not_called()

    def test_local_storage_round_trip_without_a_blob_token(self):
        """Keep token-free local reads and writes independent of the SDK."""
        payload = {"example": [1, 2, 3]}
        with tempfile.TemporaryDirectory() as directory, patch.dict(
            os.environ, {"BLOB_READ_WRITE_TOKEN": ""}
        ), patch.object(_storage, "DATA_DIR", directory), patch(
            "requests.sessions.Session.request", autospec=True
        ) as request:
            self.assertEqual(_storage.read_json("reference.json"), {})
            _storage.write_json("reference.json", payload)
            self.assertEqual(_storage.read_json("reference.json"), payload)
            self.assertEqual(json.loads((Path(directory) / "reference.json").read_text()), payload)
        request.assert_not_called()


if __name__ == "__main__":
    unittest.main()
