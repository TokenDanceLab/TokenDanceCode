import tempfile
import unittest
from pathlib import Path

from tokendance.context.transcript_search import TranscriptSearcher
from tokendance.core.events import RuntimeEvent
from tokendance.storage.transcript import TranscriptWriter


class TranscriptSearcherTests(unittest.TestCase):
    def test_search_finds_matching_transcript_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "transcript.jsonl"
            writer = TranscriptWriter(transcript)
            writer.append(RuntimeEvent(type="user_message", payload={"content": "fix parser"}))
            writer.append(RuntimeEvent(type="assistant_done", payload={"content": "done"}))

            results = TranscriptSearcher(transcript).search("parser")

        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["seq"], 1)

    def test_large_range_marks_approval_required(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            transcript = Path(tmp) / "transcript.jsonl"
            writer = TranscriptWriter(transcript)
            writer.append(RuntimeEvent(type="user_message", payload={"content": "a" * 50}))
            writer.append(RuntimeEvent(type="assistant_done", payload={"content": "b" * 50}))

            result = TranscriptSearcher(transcript, approval_threshold_chars=20).read_range(1, 2)

        self.assertTrue(result.approval_required)
        self.assertEqual(len(result.records), 2)
