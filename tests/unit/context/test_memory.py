import tempfile
import unittest
from pathlib import Path

from tokendance.context.memory import MemoryStore


class MemoryStoreTests(unittest.TestCase):
    def test_project_memory_can_be_added_listed_and_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = MemoryStore(project_root=root, home=root / "home")

            store.add_project_memory("Use unittest for now.")
            entries = store.list_project_memory()
            store.delete_project_memory(0)

        self.assertEqual(entries, ["Use unittest for now."])
        self.assertEqual(MemoryStore(project_root=root, home=root / "home").list_project_memory(), [])

    def test_global_memory_uses_home_tokendance_memory_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = MemoryStore(project_root=root / "repo", home=root / "home")

            store.add_global_memory("Prefer concise output.")

            self.assertEqual(store.list_global_memory(), ["Prefer concise output."])
