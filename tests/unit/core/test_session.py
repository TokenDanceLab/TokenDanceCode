import tempfile
import unittest
from pathlib import Path

from tokendance.core.session import SessionState


class SessionStateTests(unittest.TestCase):
    def test_new_session_state_sets_defaults_and_paths(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)

            state = SessionState.new(project_path=project)

        self.assertEqual(state.project_path, project)
        self.assertEqual(state.provider, "anthropic")
        self.assertEqual(state.model, "claude-sonnet-4-6")
        self.assertEqual(state.permission_mode, "default")
        self.assertEqual(state.mode, "work")
        self.assertEqual(state.transcript_path, "transcript.jsonl")
        self.assertEqual(state.active_task_ids, [])
        self.assertEqual(state.todo_state, [])

    def test_session_state_round_trips_json_record(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp)
            state = SessionState.new(project_path=project)

            loaded = SessionState.from_record(state.to_record())

        self.assertEqual(loaded, state)
