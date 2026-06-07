from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tokendance.storage.jsonl import append_jsonl, read_jsonl


class JsonlStorageTests(unittest.TestCase):
    def test_append_jsonl_writes_utf8_json_lines_and_read_jsonl_reads_them(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "logs" / "events.jsonl"

            append_jsonl(path, {"event": "message", "text": "你好"})
            append_jsonl(path, {"event": "count", "value": 2})

            raw = path.read_text(encoding="utf-8")
            self.assertIn("你好", raw)
            self.assertEqual(len(raw.splitlines()), 2)
            self.assertEqual(
                read_jsonl(path),
                [{"event": "message", "text": "你好"}, {"event": "count", "value": 2}],
            )

    def test_append_jsonl_preserves_existing_lines(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "events.jsonl"
            path.write_text('{"existing": true}\n', encoding="utf-8")

            append_jsonl(path, {"new": "record"})

            self.assertEqual(read_jsonl(path), [{"existing": True}, {"new": "record"}])

    def test_read_jsonl_returns_empty_list_for_missing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "missing.jsonl"

            self.assertEqual(read_jsonl(path), [])
