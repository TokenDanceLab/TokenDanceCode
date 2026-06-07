from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tokendance.core.runtime import CoreRuntime


class RuntimeRegistryTests(unittest.TestCase):
    def test_default_registry_exposes_state_and_delegation_tools(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            runtime = CoreRuntime(project_root=Path(tmp))
            names = {spec.name for spec in runtime.registry.list_tools()}

        self.assertIn("task_create", names)
        self.assertIn("todo_write", names)
        self.assertIn("subagent_run", names)
        self.assertIn("worktree_create", names)


if __name__ == "__main__":
    unittest.main()
