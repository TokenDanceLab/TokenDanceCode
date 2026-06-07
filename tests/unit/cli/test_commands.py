import unittest

from tokendance.cli.commands import CommandContext, CommandRouter


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
