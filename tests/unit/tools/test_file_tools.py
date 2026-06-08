import tempfile
import unittest
from pathlib import Path

from tokendance.tools.file import build_file_tool_specs, glob_files, read_file, write_file, edit_file
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

    def test_glob_files_excludes_internal_and_sensitive_paths_by_default(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "src").mkdir()
            (root / "src" / "app.py").write_text("", encoding="utf-8")
            (root / ".git" / "objects").mkdir(parents=True)
            (root / ".git" / "objects" / "blob").write_text("", encoding="utf-8")
            (root / ".tokendance" / "sessions").mkdir(parents=True)
            (root / ".tokendance" / "sessions" / "transcript.jsonl").write_text("", encoding="utf-8")
            (root / "__pycache__").mkdir()
            (root / "__pycache__" / "app.pyc").write_text("", encoding="utf-8")
            (root / ".env").write_text("SECRET=value", encoding="utf-8")
            context = ToolContext(workspace_root=root)

            result = glob_files(context, {"pattern": "**/*"})

        self.assertEqual(result.data["matches"], ["src/app.py"])

    def test_file_tool_specs_document_required_arguments(self) -> None:
        specs = {spec.name: spec for spec in build_file_tool_specs()}

        self.assertEqual(specs["read_file"].input_schema["required"], ["path"])
        self.assertIn("path", specs["read_file"].input_schema["properties"])
        self.assertEqual(specs["write_file"].input_schema["required"], ["path", "content"])
        self.assertEqual(specs["edit_file"].input_schema["required"], ["path", "old_text", "new_text"])
        self.assertEqual(specs["glob"].input_schema["required"], ["pattern"])
