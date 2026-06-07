import tempfile
import unittest
from pathlib import Path

from tokendance.git.quality import QualityGate
from tokendance.git.review import ReviewService
from tokendance.git.revert import RevertService


class ReviewRevertQualityTests(unittest.TestCase):
    def test_review_reports_conflict_markers_without_modifying_files(self) -> None:
        diff = "+<<<<<<< HEAD\n+bad\n+=======\n+other\n+>>>>>>> branch\n"

        report = ReviewService().review_diff(diff)

        self.assertEqual(len(report.findings), 1)
        self.assertIn("conflict", report.findings[0].message.lower())

    def test_revert_patch_artifact_reverses_simple_patch(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "notes.txt").write_text("hello\nnew\n", encoding="utf-8")
            patch = root / ".tokendance" / "sessions" / "s1" / "edits" / "patch-0001.patch"
            patch.parent.mkdir(parents=True)
            patch.write_text(
                "\n".join(
                    [
                        "*** Begin Patch",
                        "*** Update File: notes.txt",
                        "@@",
                        "-old",
                        "+new",
                        "*** End Patch",
                    ]
                ),
                encoding="utf-8",
            )

            result = RevertService(root).revert_patch_artifact(patch)
            content = (root / "notes.txt").read_text(encoding="utf-8")

        self.assertTrue(result.reverted)
        self.assertEqual(content, "hello\nold\n")

    def test_quality_gate_runs_configured_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)

            result = QualityGate(root).run("python -c \"print('ok')\"")

        self.assertEqual(result.exit_code, 0)
        self.assertIn("ok", result.stdout_preview)
