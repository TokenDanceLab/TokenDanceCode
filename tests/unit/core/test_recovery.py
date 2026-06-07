import unittest

from tokendance.core.recovery import RecoveryPolicy, build_continuation_prompt, recover_provider_call
from tokendance.execution.result import CommandResult
from tokendance.models.errors import BadRequest, ContextLengthExceeded, ProviderUnavailable, RateLimited
from tokendance.tools.spec import ToolResult


class RecoveryTests(unittest.TestCase):
    def test_retries_rate_limited_provider_call_until_success(self) -> None:
        attempts = 0
        events = []

        def call_provider() -> str:
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise RateLimited("slow down")
            return "ok"

        result = recover_provider_call(
            call_provider,
            policy=RecoveryPolicy(max_retries=2),
            on_recovery_event=events.append,
        )

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 3)
        self.assertEqual([event.kind for event in events], ["retry", "retry"])
        self.assertEqual([event.attempt for event in events], [1, 2])
        self.assertEqual({event.error_type for event in events}, {"RateLimited"})

    def test_records_give_up_when_provider_unavailable_retry_budget_is_exhausted(self) -> None:
        attempts = 0
        events = []

        def call_provider() -> str:
            nonlocal attempts
            attempts += 1
            raise ProviderUnavailable("temporarily unavailable")

        with self.assertRaises(ProviderUnavailable):
            recover_provider_call(
                call_provider,
                policy=RecoveryPolicy(max_retries=1),
                on_recovery_event=events.append,
            )

        self.assertEqual(attempts, 2)
        self.assertEqual([event.kind for event in events], ["retry", "give_up"])
        self.assertEqual(events[-1].attempt, 2)

    def test_compacts_context_once_then_retries_provider_call(self) -> None:
        attempts = 0
        compacted = []
        events = []

        def call_provider() -> str:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise ContextLengthExceeded("context too long")
            return "after compact"

        result = recover_provider_call(
            call_provider,
            policy=RecoveryPolicy(max_retries=0, max_context_compactions=1),
            compact_context=lambda: compacted.append("compacted"),
            on_recovery_event=events.append,
        )

        self.assertEqual(result, "after compact")
        self.assertEqual(attempts, 2)
        self.assertEqual(compacted, ["compacted"])
        self.assertEqual([event.kind for event in events], ["compact"])
        self.assertEqual(events[0].error_type, "ContextLengthExceeded")

    def test_does_not_retry_non_recoverable_provider_errors(self) -> None:
        attempts = 0

        def call_provider() -> str:
            nonlocal attempts
            attempts += 1
            raise BadRequest("bad input")

        with self.assertRaises(BadRequest):
            recover_provider_call(call_provider, policy=RecoveryPolicy(max_retries=3))

        self.assertEqual(attempts, 1)

    def test_build_continuation_prompt_mentions_command_artifact_and_preview(self) -> None:
        result = CommandResult(
            command="Get-Content big.log",
            cwd="C:/repo",
            shell="powershell",
            exit_code=0,
            stdout_preview="line 1\nline 2",
            stderr_preview="",
            stdout_artifact="tool-outputs/stdout-0001.txt",
            stderr_artifact=None,
            duration_ms=42,
            timed_out=False,
        )

        prompt = build_continuation_prompt(result)

        self.assertIn("Continue", prompt)
        self.assertIn("tool-outputs/stdout-0001.txt", prompt)
        self.assertIn("line 1\nline 2", prompt)

    def test_build_continuation_prompt_mentions_tool_artifact_and_content_preview(self) -> None:
        result = ToolResult.ok(content="visible preview", artifact_ref="edits/patch-0001.patch")

        prompt = build_continuation_prompt(result)

        self.assertIn("Continue", prompt)
        self.assertIn("edits/patch-0001.patch", prompt)
        self.assertIn("visible preview", prompt)


if __name__ == "__main__":
    unittest.main()
