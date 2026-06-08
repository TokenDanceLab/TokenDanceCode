import unittest
import tempfile
import subprocess
from pathlib import Path

from tokendance.cli.commands import CommandContext, CommandRouter
from tokendance.core.events import RuntimeEvent
from tokendance.storage.transcript import TranscriptWriter


class CommandRouterTests(unittest.TestCase):
    def test_help_lists_core_slash_commands(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1")

        result = router.handle("/help", context)

        self.assertFalse(result.exit_requested)
        self.assertIn("/status", result.message)
        self.assertIn("/exit", result.message)

    def test_mode_switches_between_work_and_teach(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1", mode="work")

        result = router.handle("/mode teach", context)

        self.assertEqual(context.mode, "teach")
        self.assertIn("teach", result.message)

    def test_exit_requests_shell_shutdown(self) -> None:
        router = CommandRouter()
        context = CommandContext(session_id="session-1")

        result = router.handle("/exit", context)

        self.assertTrue(result.exit_requested)
        self.assertIn("exit", result.message.lower())

    def test_memory_add_and_list_project_memory(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = CommandContext(session_id="session-1", project_path=root, home=root / "home")
            router = CommandRouter()

            add_result = router.handle("/memory add project Use unittest.", context)
            list_result = router.handle("/memory", context)

        self.assertIn("saved", add_result.message.lower())
        self.assertIn("Use unittest.", list_result.message)

    def test_transcript_search_uses_current_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            transcript = root / "transcript.jsonl"
            TranscriptWriter(transcript).append(RuntimeEvent(type="user_message", payload={"content": "parser"}))
            context = CommandContext(session_id="session-1", project_path=root, transcript_path=transcript)

            result = CommandRouter().handle("/transcript search parser", context)

        self.assertIn("seq=1", result.message)

    def test_compact_writes_summary_for_current_session(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-1"
            transcript = session_dir / "transcript.jsonl"
            TranscriptWriter(transcript).append(RuntimeEvent(type="user_message", payload={"content": "hello"}))
            context = CommandContext(
                session_id="session-1",
                project_path=root,
                session_dir=session_dir,
                transcript_path=transcript,
            )

            result = CommandRouter().handle("/compact", context)

        self.assertIn("compact", result.message.lower())

    def test_diff_and_review_commands_use_git_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True, text=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Tokendance Test"], cwd=root, check=True)
            (root / "notes.txt").write_text("old\n", encoding="utf-8")
            subprocess.run(["git", "add", "notes.txt"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "initial"], cwd=root, check=True, capture_output=True, text=True)
            (root / "notes.txt").write_text("old\nTODO\n", encoding="utf-8")
            context = CommandContext(session_id="session-1", project_path=root)

            diff = CommandRouter().handle("/diff", context)
            review = CommandRouter().handle("/review", context)

        self.assertIn("+TODO", diff.message)
        self.assertIn("TODO", review.message)

    def test_revert_latest_uses_latest_patch_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-1"
            edits = session_dir / "edits"
            edits.mkdir(parents=True)
            (root / "notes.txt").write_text("new\n", encoding="utf-8")
            (edits / "patch-0001.patch").write_text(
                "\n".join(
                    [
                        "*** Begin Patch",
                        "*** Update File: notes.txt",
                        "@@",
                        "-old",
                        "+new",
                        "*** End Patch",
                    ]
                ),
                encoding="utf-8",
            )
            context = CommandContext(session_id="session-1", project_path=root, session_dir=session_dir)

            result = CommandRouter().handle("/revert latest", context)
            content = (root / "notes.txt").read_text(encoding="utf-8")

        self.assertIn("reverted", result.message.lower())
        self.assertEqual(content, "old\n")

    def test_quality_runs_command(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            result = CommandRouter().handle(
                "/quality python -c \"print('quality-ok')\"",
                CommandContext(session_id="session-1", project_path=root),
            )

        self.assertIn("quality-ok", result.message)

    def test_agents_and_worktree_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            subprocess.run(["git", "init"], cwd=root, check=True, capture_output=True, text=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=root, check=True)
            subprocess.run(["git", "config", "user.name", "Tokendance Test"], cwd=root, check=True)
            (root / "notes.txt").write_text("base\n", encoding="utf-8")
            subprocess.run(["git", "add", "notes.txt"], cwd=root, check=True)
            subprocess.run(["git", "commit", "-m", "initial"], cwd=root, check=True, capture_output=True, text=True)
            context = CommandContext(session_id="session-1", project_path=root)
            router = CommandRouter()

            agents = router.handle("/agents", context)
            created = router.handle("/worktree create cli-wt", context)
            listed = router.handle("/worktree list", context)
            removed = router.handle("/worktree remove cli-wt", context)

        self.assertIn("No subagents", agents.message)
        self.assertIn("cli-wt", created.message)
        self.assertIn("cli-wt", listed.message)
        self.assertIn("removed", removed.message.lower())

    def test_tasks_command_creates_lists_and_updates_tasks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            context = CommandContext(session_id="session-1", project_path=root)
            router = CommandRouter()

            created = router.handle("/tasks create Stage 12 CLI", context)
            listed = router.handle("/tasks", context)
            task_id = created.message.split()[1]
            updated = router.handle(f"/tasks status {task_id} in_progress", context)

        self.assertIn("Created", created.message)
        self.assertIn("Stage 12 CLI", listed.message)
        self.assertIn("in_progress", updated.message)

    def test_todo_command_writes_lists_and_updates_session_todos(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            session_dir = root / ".tokendance" / "sessions" / "session-1"
            context = CommandContext(session_id="session-1", project_path=root, session_dir=session_dir)
            router = CommandRouter()

            written = router.handle("/todo add Run unittest", context)
            listed = router.handle("/todo", context)
            todo_id = written.message.split()[1]
            updated = router.handle(f"/todo status {todo_id} completed", context)

        self.assertIn("Wrote", written.message)
        self.assertIn("Run unittest", listed.message)
        self.assertIn("completed", updated.message)
