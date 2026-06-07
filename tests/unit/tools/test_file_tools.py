import tempfile
import unittest
from pathlib import Path

from tokendance.tools.file import glob_files, read_file, write_file, edit_file
from tokendance.tools.spec import ToolContext


class FileToolTests(unittest.TestCase):
    def test_read_and_write_file_use_utf8_inside_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = ToolContext(workspace_root=root)

            write_result = write_file(context, {"path": "notes.txt", "content": "hello 中文"})
            read_result = read_file(context, {"path": "notes.txt"})

        self.assertEqual(write_result.status, "ok")
        self.assertEqual(read_result.content, "hello 中文")

    def test_edit_file_replaces_exact_text_once(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "notes.txt").write_text("old value\n", encoding="utf-8")
            context = ToolContext(workspace_root=root)

            result = edit_file(
                context,
                {"path": "notes.txt", "old_text": "old value", "new_text": "new value"},
            )

            content = (root / "notes.txt").read_text(encoding="utf-8")

        self.assertEqual(result.status, "ok")
        self.assertEqual(content, "new value\n")

    def test_glob_files_returns_relative_matches(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.py").write_text("", encoding="utf-8")
            (root / "b.txt").write_text("", encoding="utf-8")
            context = ToolContext(workspace_root=root)

            result = glob_files(context, {"pattern": "*.py"})

        self.assertEqual(result.data["matches"], ["a.py"])
