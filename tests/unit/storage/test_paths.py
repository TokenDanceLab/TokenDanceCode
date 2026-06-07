from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from tokendance.storage.paths import (
    StoragePaths,
    normalize_path,
    resolve_global_dir,
    resolve_project_dir,
)


class StoragePathTests(unittest.TestCase):
    def test_resolve_global_dir_uses_home_tokendance_and_creates_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            home = Path(temp_dir)

            storage_dir = resolve_global_dir(home=home)

            self.assertEqual(storage_dir, home / ".tokendance")
            self.assertTrue(storage_dir.is_dir())

    def test_resolve_project_dir_uses_project_tokendance_and_creates_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project_root = Path(temp_dir) / "Project"
            project_root.mkdir()

            storage_dir = resolve_project_dir(project_root)

            self.assertEqual(storage_dir, project_root / ".tokendance")
            self.assertTrue(storage_dir.is_dir())

    def test_normalize_path_resolves_path_and_casefolds_on_windows(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            nested = root / "MixedCase"
            nested.mkdir()
            target = nested / "File.txt"
            target.write_text("content", encoding="utf-8")
            raw_path = nested / ".." / "MixedCase" / "File.txt"

            normalized = normalize_path(raw_path)

            expected = str(target.resolve())
            if os.name == "nt":
                expected = expected.casefold()
            self.assertEqual(normalized, expected)

    def test_storage_paths_groups_global_and_project_dirs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = StoragePaths(
                global_dir=resolve_global_dir(home=root / "home"),
                project_dir=resolve_project_dir(root / "project"),
            )

            self.assertEqual(paths.global_dir, root / "home" / ".tokendance")
            self.assertEqual(paths.project_dir, root / "project" / ".tokendance")

