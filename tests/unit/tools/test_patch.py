import tempfile
import unittest
from pathlib import Path

from tokendance.tools.patch import apply_patch_tool
from tokendance.tools.spec import ToolContext


class PatchToolTests(unittest.TestCase):
    def test_apply_patch_updates_file_and_records_patch_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-test"
            (root / "notes.txt").write_text("hello\nold\n", encoding="utf-8")
            context = ToolContext(workspace_root=root, session_dir=session_dir)

            result = apply_patch_tool(
                context,
                {
                    "patch": "\n".join(
                        [
                            "*** Begin Patch",
                            "*** Update File: notes.txt",
                            "@@",
                            "-old",
                            "+new",
                            "*** End Patch",
                        ]
                    )
                },
            )

            content = (root / "notes.txt").read_text(encoding="utf-8")
            artifact = session_dir / result.artifact_ref
            artifact_exists = artifact.is_file()

        self.assertEqual(result.status, "ok")
        self.assertEqual(content, "hello\nnew\n")
        self.assertTrue(artifact_exists)
