from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tokendance.storage.jsonl import read_jsonl


@dataclass(frozen=True)
class TranscriptRange:
    records: list[dict[str, Any]]
    approval_required: bool
    char_count: int


class TranscriptSearcher:
    def __init__(self, transcript_path: Path, approval_threshold_chars: int = 8000) -> None:
        self.transcript_path = Path(transcript_path)
        self.approval_threshold_chars = approval_threshold_chars

    def search(self, query: str) -> list[dict[str, Any]]:
        needle = query.casefold()
        return [
            record
            for record in read_jsonl(self.transcript_path)
            if needle in json.dumps(record, ensure_ascii=False).casefold()
        ]

    def read_range(self, start_seq: int, end_seq: int) -> TranscriptRange:
        records = [
            record
            for record in read_jsonl(self.transcript_path)
            if start_seq <= int(record.get("seq", 0)) <= end_seq
        ]
        char_count = sum(len(json.dumps(record, ensure_ascii=False)) for record in records)
        return TranscriptRange(
            records=records,
            approval_required=char_count > self.approval_threshold_chars,
            char_count=char_count,
        )
