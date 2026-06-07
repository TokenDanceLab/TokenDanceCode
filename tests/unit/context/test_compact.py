import tempfile
import unittest
from pathlib import Path

from tokendance.context.compact import CompactService
from tokendance.core.events import RuntimeEvent
from tokendance.storage.transcript import TranscriptWriter


class CompactServiceTests(unittest.TestCase):
    def test_manual_compact_writes_summary_without_deleting_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            session_dir = Path(tmp) / "session"
            transcript = session_dir / "transcript.jsonl"
            writer = TranscriptWriter(transcript)
            writer.append(RuntimeEvent(type="user_message", payload={"content": "first"}))
            writer.append(RuntimeEvent(type="assistant_done", payload={"content": "second"}))

            summary_path = CompactService(session_dir).manual_compact(transcript)

            summary = summary_path.read_text(encoding="utf-8")
            records = writer.read_all()

        self.assertIn("seq 1-2", summary)
        self.assertEqual(len(records), 2)
