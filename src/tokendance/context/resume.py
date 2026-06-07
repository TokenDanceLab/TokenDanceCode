from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tokendance.core.session import SessionState
from tokendance.storage.jsonl import read_jsonl
from tokendance.storage.paths import resolve_project_dir
from tokendance.storage.transcript import load_session_state


@dataclass(frozen=True)
class ResumeResult:
    state: SessionState
    session_dir: Path
    recent_records: list[dict[str, Any]]


class ResumeService:
    def __init__(self, project_root: Path) -> None:
        self.project_root = Path(project_root)
        self.project_dir = resolve_project_dir(self.project_root)

    def latest(self, recent_limit: int = 20) -> ResumeResult:
        sessions_dir = self.project_dir / "sessions"
        session_jsons = sorted(
            sessions_dir.glob("*/session.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if not session_jsons:
            raise FileNotFoundError("No resumable Tokendance sessions found.")
        session_json = session_jsons[0]
        state = load_session_state(session_json)
        session_dir = session_json.parent
        transcript_path = session_dir / state.transcript_path
        records = read_jsonl(transcript_path)[-recent_limit:]
        return ResumeResult(state=state, session_dir=session_dir, recent_records=records)
