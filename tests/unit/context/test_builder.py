import tempfile
import unittest
from pathlib import Path

from tokendance.context.builder import ProjectInstruction, read_project_instructions


class ProjectInstructionTests(unittest.TestCase):
    def test_reads_known_project_instruction_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "AGENTS.md").write_text("agent rules", encoding="utf-8")
            (root / "README.md").write_text("readme notes", encoding="utf-8")
            (root / ".tokendance").mkdir()
            (root / ".tokendance" / "instructions.md").write_text("td rules", encoding="utf-8")

            instructions = read_project_instructions(root)

        self.assertEqual(
            instructions,
            [
                ProjectInstruction(path="AGENTS.md", content="agent rules"),
                ProjectInstruction(path="README.md", content="readme notes"),
                ProjectInstruction(path=".tokendance/instructions.md", content="td rules"),
            ],
        )
