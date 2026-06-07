import tempfile
import unittest
from pathlib import Path

from tokendance.core.events import RuntimeEvent
from tokendance.core.session import SessionState
from tokendance.storage.transcript import (
    SessionStore,
    TranscriptWriter,
    load_session_state,
)


class TranscriptStorageTests(unittest.TestCase):
    def test_create_session_writes_session_json_and_transcript_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state = SessionState.new(project_path=project, session_id="session-test")

            paths = SessionStore(project).create_session(state)

            self.assertTrue(paths.session_dir.is_dir())
            self.assertTrue((paths.session_dir / "session.json").is_file())
            self.assertTrue((paths.session_dir / "transcript.jsonl").is_file())

    def test_session_metadata_round_trips_from_disk(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state = SessionState.new(project_path=project, session_id="session-test")
            paths = SessionStore(project).create_session(state)

            loaded = load_session_state(paths.session_dir / "session.json")

        self.assertEqual(loaded, state)

    def test_transcript_writer_assigns_incrementing_sequence_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state = SessionState.new(project_path=project, session_id="session-test")
            paths = SessionStore(project).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)

            writer.append(RuntimeEvent(type="user_message", payload={"content": "你好"}))
            writer.append(
                RuntimeEvent(
                    type="tool_call_started",
                    payload={"path": r"C:\repo\中文.py"},
                    artifact_ref="tool-outputs/output-0001.txt",
                )
            )

            records = writer.read_all()

        self.assertEqual([record["seq"] for record in records], [1, 2])
        self.assertEqual(records[0]["payload"]["content"], "你好")
        self.assertEqual(records[1]["payload"]["path"], r"C:\repo\中文.py")

    def test_transcript_writer_continues_sequence_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state = SessionState.new(project_path=project, session_id="session-test")
            paths = SessionStore(project).create_session(state)

            TranscriptWriter(paths.transcript_path).append(
                RuntimeEvent(type="user_message", payload={"content": "first"})
            )
            TranscriptWriter(paths.transcript_path).append(
                RuntimeEvent(type="assistant_done", payload={"message_id": "second"})
            )

            records = TranscriptWriter(paths.transcript_path).read_all()

        self.assertEqual([record["seq"] for record in records], [1, 2])
