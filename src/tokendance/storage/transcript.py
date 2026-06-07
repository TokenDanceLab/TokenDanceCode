from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tokendance.core.events import RuntimeEvent
from tokendance.core.session import SessionState
from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.jsonl import append_jsonl, read_jsonl
from tokendance.storage.paths import resolve_project_dir


@dataclass(frozen=True)
class SessionPaths:
    session_dir: Path
    session_json_path: Path
    transcript_path: Path


class SessionStore:
    def __init__(self, project_root: Path) -> None:
        self.project_root = Path(project_root)
        self.project_dir = resolve_project_dir(self.project_root)

    def create_session(self, state: SessionState) -> SessionPaths:
        session_dir = self.project_dir / "sessions" / state.session_id
        session_dir.mkdir(parents=True, exist_ok=True)
        session_json_path = session_dir / "session.json"
        transcript_path = session_dir / state.transcript_path
        atomic_write_text(
            session_json_path,
            json.dumps(state.to_record(), ensure_ascii=False, indent=2),
        )
        transcript_path.touch(exist_ok=True)
        return SessionPaths(
            session_dir=session_dir,
            session_json_path=session_json_path,
            transcript_path=transcript_path,
        )


class TranscriptWriter:
    def __init__(self, transcript_path: Path) -> None:
        self.transcript_path = Path(transcript_path)

    def append(self, event: RuntimeEvent) -> dict[str, Any]:
        next_seq = self._next_seq()
        record = event.to_record()
        record["seq"] = next_seq
        append_jsonl(self.transcript_path, record)
        return record

    def read_all(self) -> list[dict[str, Any]]:
        return read_jsonl(self.transcript_path)

    def _next_seq(self) -> int:
        records = self.read_all()
        if not records:
            return 1
        return int(records[-1]["seq"]) + 1


def load_session_state(path: Path) -> SessionState:
    record = json.loads(Path(path).read_text(encoding="utf-8"))
    return SessionState.from_record(record)
