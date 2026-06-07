import tempfile
import unittest
from pathlib import Path

from tokendance.context.resume import ResumeService
from tokendance.core.events import RuntimeEvent
from tokendance.core.session import SessionState
from tokendance.storage.transcript import SessionStore, TranscriptWriter


class ResumeIntegrationTests(unittest.TestCase):
    def test_resume_latest_loads_session_and_recent_transcript_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            TranscriptWriter(paths.transcript_path).append(
                RuntimeEvent(type="user_message", payload={"content": "hello"})
            )

            resumed = ResumeService(root).latest()

        self.assertEqual(resumed.state.session_id, "session-test")
        self.assertEqual(resumed.recent_records[0]["payload"]["content"], "hello")
