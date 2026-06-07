from __future__ import annotations

from pathlib import Path

from tokendance.storage.atomic import atomic_write_text
from tokendance.storage.jsonl import read_jsonl


class CompactService:
    def __init__(self, session_dir: Path) -> None:
        self.session_dir = Path(session_dir)

    def manual_compact(self, transcript_path: Path) -> Path:
        records = read_jsonl(transcript_path)
        compact_dir = self.session_dir / "compact"
        compact_dir.mkdir(parents=True, exist_ok=True)
        index = len(list(compact_dir.glob("compact-*.md"))) + 1
        summary_path = compact_dir / f"compact-{index:04d}.md"
        if records:
            seq_range = f"seq {records[0]['seq']}-{records[-1]['seq']}"
        else:
            seq_range = "seq none"
        content = "\n".join(
            [
                "# Compact Summary",
                "",
                f"Range: {seq_range}",
                f"Events: {len(records)}",
            ]
        )
        atomic_write_text(summary_path, content)
        return summary_path
