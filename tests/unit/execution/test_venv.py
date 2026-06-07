import tempfile
import unittest
from pathlib import Path

from tokendance.execution.venv import find_project_venv


class VenvDetectionTests(unittest.TestCase):
    def test_find_project_venv_detects_windows_python(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            python_path = root / ".venv" / "Scripts" / "python.exe"
            python_path.parent.mkdir(parents=True)
            python_path.write_text("", encoding="utf-8")

            detected = find_project_venv(root)

        self.assertEqual(detected, python_path)

    def test_find_project_venv_returns_none_when_missing(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self.assertIsNone(find_project_venv(Path(tmp)))
