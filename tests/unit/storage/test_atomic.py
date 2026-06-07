from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tokendance.storage.atomic import atomic_write_text


class AtomicWriteTests(unittest.TestCase):
    def test_atomic_write_text_writes_utf8_content_and_creates_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "nested" / "state.txt"

            atomic_write_text(target, "hello\n中文\n")

            self.assertEqual(target.read_text(encoding="utf-8"), "hello\n中文\n")

    def test_atomic_write_text_replaces_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "state.txt"
            target.write_text("old", encoding="utf-8")

            atomic_write_text(target, "new")

            self.assertEqual(target.read_text(encoding="utf-8"), "new")

    def test_atomic_write_text_keeps_original_file_when_replace_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            target = Path(temp_dir) / "state.txt"
            target.write_text("old", encoding="utf-8")

            with patch("tokendance.storage.atomic.os.replace", side_effect=RuntimeError("boom")):
                with self.assertRaises(RuntimeError):
                    atomic_write_text(target, "new")

            self.assertEqual(target.read_text(encoding="utf-8"), "old")
            self.assertEqual([path.name for path in Path(temp_dir).iterdir()], ["state.txt"])

