from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


def append_jsonl(path: Path, record: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    needs_separator = _needs_line_separator(target)
    line = json.dumps(record, ensure_ascii=False)

    with target.open("a", encoding="utf-8", newline="\n") as file:
        if needs_separator:
            file.write("\n")
        file.write(line)
        file.write("\n")


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    target = Path(path)
    if not target.exists():
        return []

    records: list[dict[str, Any]] = []
    with target.open("r", encoding="utf-8") as file:
        for line in file:
            stripped = line.strip()
            if stripped:
                records.append(json.loads(stripped))
    return records


def _needs_line_separator(path: Path) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False

    with path.open("rb") as file:
        file.seek(-1, os.SEEK_END)
        return file.read(1) not in {b"\n", b"\r"}
