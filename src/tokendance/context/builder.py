from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ProjectInstruction:
    path: str
    content: str


_INSTRUCTION_PATHS = [
    "AGENTS.md",
    "CLAUDE.md",
    "README.md",
    ".tokendance/instructions.md",
]


def read_project_instructions(project_root: Path) -> list[ProjectInstruction]:
    root = Path(project_root)
    instructions: list[ProjectInstruction] = []
    for relative in _INSTRUCTION_PATHS:
        path = root / relative
        if path.exists() and path.is_file():
            instructions.append(ProjectInstruction(path=relative, content=path.read_text(encoding="utf-8")))
    return instructions
