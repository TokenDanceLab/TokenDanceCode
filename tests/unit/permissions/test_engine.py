import tempfile
import unittest
from pathlib import Path

from tokendance.permissions.engine import PermissionDecision, PermissionEngine


class PermissionEngineTests(unittest.TestCase):
    def test_decision_is_dataclass_value(self) -> None:
        decision = PermissionDecision(action="allow", reason="inside workspace")

        self.assertEqual(decision.action, "allow")
        self.assertEqual(decision.reason, "inside workspace")

    def test_all_modes_allow_workspace_reads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = PermissionEngine()

            for mode in ["default", "safe", "auto", "yolo"]:
                with self.subTest(mode=mode):
                    decision = engine.evaluate("read_file", {"path": "notes.txt"}, mode, root)
                    self.assertEqual(decision.action, "allow")

    def test_workspace_writes_ask_only_in_safe_mode(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = PermissionEngine()

            self.assertEqual(
                engine.evaluate("write_file", {"path": "notes.txt"}, "safe", root).action,
                "ask",
            )
            for mode in ["default", "auto", "yolo"]:
                with self.subTest(mode=mode):
                    decision = engine.evaluate("edit_file", {"path": "notes.txt"}, mode, root)
                    self.assertEqual(decision.action, "allow")

    def test_workspace_outside_reads_ask_and_writes_deny(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            root.mkdir()
            outside = Path(tmp) / "outside.txt"
            engine = PermissionEngine()

            read_decision = engine.evaluate("read_file", {"path": outside}, "default", root)
            write_decision = engine.evaluate("write_file", {"path": outside}, "yolo", root)

        self.assertEqual(read_decision.action, "ask")
        self.assertEqual(write_decision.action, "deny")

    def test_patch_paths_outside_workspace_are_denied(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "workspace"
            root.mkdir()
            outside = Path(tmp) / "outside.txt"
            patch = "\n".join(
                [
                    "*** Begin Patch",
                    f"*** Update File: {outside}",
                    "@@",
                    "-old",
                    "+new",
                    "*** End Patch",
                ]
            )
            decision = PermissionEngine().evaluate(
                "apply_patch",
                {"patch": patch},
                "default",
                root,
            )

        self.assertEqual(decision.action, "deny")

    def test_shell_decision_uses_powershell_classification(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            engine = PermissionEngine()

            safe = engine.evaluate("run_powershell", {"command": "Get-ChildItem"}, "safe", root)
            ask = engine.evaluate("run_powershell", {"command": "python -m unittest"}, "auto", root)
            denied = engine.evaluate("run_powershell", {"command": "git reset --hard"}, "yolo", root)

        self.assertEqual(safe.action, "allow")
        self.assertEqual(ask.action, "ask")
        self.assertEqual(denied.action, "deny")

    def test_invalid_mode_raises_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, "invalid"):
                PermissionEngine().evaluate("read_file", {"path": "notes.txt"}, "invalid", Path(tmp))

