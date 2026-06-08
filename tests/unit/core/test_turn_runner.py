import tempfile
import unittest
from pathlib import Path

from tokendance.core.session import SessionState
from tokendance.core.turn import TurnRunner
from tokendance.models.errors import RateLimited
from tokendance.models.mock import MockProvider
from tokendance.models.types import ModelEvent, TDToolCall
from tokendance.storage.transcript import SessionStore, TranscriptWriter
from tokendance.tools.file import build_file_tool_specs
from tokendance.tools.orchestrator import ToolOrchestrator
from tokendance.tools.registry import ToolRegistry


def _registry_with_file_tools() -> ToolRegistry:
    registry = ToolRegistry()
    for spec in build_file_tool_specs():
        registry.register(spec)
    return registry


class TurnRunnerTests(unittest.TestCase):
    def test_runs_pure_text_turn_and_records_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(
                responses=[[ModelEvent.text_delta("hello"), ModelEvent.message_done("end_turn")]]
            )
            runner = TurnRunner(provider=provider, registry=ToolRegistry())

            result = runner.run_turn("hi", state=state, transcript_writer=writer)
            records = writer.read_all()

        self.assertEqual(result.final_text, "hello")
        self.assertEqual([record["type"] for record in records], ["user_message", "assistant_delta", "assistant_done"])

    def test_streams_text_delta_before_provider_stream_finishes(self) -> None:
        rendered: list[str] = []

        class StreamingProbeProvider:
            def stream_response(self, *, messages, tools):
                yield ModelEvent.text_delta("first")
                if rendered != ["first"]:
                    raise AssertionError("first delta was not rendered before stream continued")
                yield ModelEvent.text_delta("second")
                yield ModelEvent.message_done()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)

            result = TurnRunner(provider=StreamingProbeProvider(), registry=ToolRegistry()).run_turn(
                "stream please",
                state=state,
                transcript_writer=writer,
                on_text_delta=rendered.append,
            )

        self.assertEqual(result.final_text, "firstsecond")
        self.assertEqual(rendered, ["first", "second"])

    def test_executes_tool_call_and_feeds_result_back_to_model(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "notes.txt").write_text("note body", encoding="utf-8")
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(
                responses=[
                    [
                        ModelEvent.tool_call(
                            TDToolCall(id="call-1", name="read_file", arguments={"path": "notes.txt"})
                        ),
                        ModelEvent.message_done("tool_calls"),
                    ],
                    [ModelEvent.text_delta("I read note body"), ModelEvent.message_done("end_turn")],
                ]
            )
            runner = TurnRunner(provider=provider, registry=_registry_with_file_tools())

            result = runner.run_turn("read notes", state=state, transcript_writer=writer)
            records = writer.read_all()

        self.assertEqual(result.final_text, "I read note body")
        self.assertEqual(len(provider.calls), 2)
        second_call_messages = provider.calls[1].messages
        self.assertEqual(second_call_messages[-2].role, "assistant")
        self.assertEqual(second_call_messages[-2].content[0].type, "tool_use")
        self.assertEqual(second_call_messages[-2].content[0].tool_call_id, "call-1")
        self.assertEqual(second_call_messages[-1].role, "tool")
        self.assertIn("note body", second_call_messages[-1].content[0].tool_result)
        self.assertIn("tool_call_completed", [record["type"] for record in records])

    def test_supports_multiple_tool_call_rounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text("a", encoding="utf-8")
            (root / "b.txt").write_text("b", encoding="utf-8")
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(
                responses=[
                    [ModelEvent.tool_call(TDToolCall("call-1", "read_file", {"path": "a.txt"}))],
                    [ModelEvent.tool_call(TDToolCall("call-2", "read_file", {"path": "b.txt"}))],
                    [ModelEvent.text_delta("done"), ModelEvent.message_done()],
                ]
            )

            result = TurnRunner(provider=provider, registry=_registry_with_file_tools()).run_turn(
                "read both",
                state=state,
                transcript_writer=writer,
            )

        self.assertEqual(result.final_text, "done")
        self.assertEqual(len(provider.calls), 3)

    def test_default_model_call_limit_allows_long_tool_sequences(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            responses = []
            for index in range(10):
                path = f"{index}.txt"
                (root / path).write_text(str(index), encoding="utf-8")
                responses.append([ModelEvent.tool_call(TDToolCall(f"call-{index}", "read_file", {"path": path}))])
            responses.append([ModelEvent.text_delta("done"), ModelEvent.message_done()])
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(responses=responses)

            result = TurnRunner(provider=provider, registry=_registry_with_file_tools()).run_turn(
                "read many files",
                state=state,
                transcript_writer=writer,
            )

        self.assertEqual(result.final_text, "done")
        self.assertEqual(len(provider.calls), 11)

    def test_groups_multiple_tool_results_after_one_assistant_tool_use_message(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text("a", encoding="utf-8")
            (root / "b.txt").write_text("b", encoding="utf-8")
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(
                responses=[
                    [
                        ModelEvent.tool_call(TDToolCall("call-1", "read_file", {"path": "a.txt"})),
                        ModelEvent.tool_call(TDToolCall("call-2", "read_file", {"path": "b.txt"})),
                    ],
                    [ModelEvent.text_delta("done"), ModelEvent.message_done()],
                ]
            )

            result = TurnRunner(provider=provider, registry=_registry_with_file_tools()).run_turn(
                "read both",
                state=state,
                transcript_writer=writer,
            )

        self.assertEqual(result.final_text, "done")
        self.assertEqual(len(provider.calls), 2)
        second_call_messages = provider.calls[1].messages
        self.assertEqual(second_call_messages[-2].role, "assistant")
        self.assertEqual([block.tool_call_id for block in second_call_messages[-2].content], ["call-1", "call-2"])
        self.assertEqual(second_call_messages[-1].role, "tool")
        self.assertEqual([block.tool_call_id for block in second_call_messages[-1].content], ["call-1", "call-2"])

    def test_records_error_when_model_call_limit_is_reached(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a.txt").write_text("a", encoding="utf-8")
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = MockProvider(
                responses=[[ModelEvent.tool_call(TDToolCall("call-1", "read_file", {"path": "a.txt"}))]]
            )
            rendered_events = []

            TurnRunner(provider=provider, registry=_registry_with_file_tools(), max_model_calls=1).run_turn(
                "read forever",
                state=state,
                transcript_writer=writer,
                on_runtime_event=rendered_events.append,
            )
            records = writer.read_all()

        self.assertEqual(records[-1]["type"], "error")
        self.assertIn("model-call limit", records[-1]["payload"]["message"])
        self.assertEqual(rendered_events[-1].type, "error")

    def test_recovers_transient_provider_error_during_model_call(self) -> None:
        class FlakyProvider:
            def __init__(self) -> None:
                self.calls = 0

            def stream_response(self, *, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    raise RateLimited("slow down")
                yield ModelEvent.text_delta("recovered")
                yield ModelEvent.message_done()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state = SessionState.new(project_path=root, session_id="session-test")
            paths = SessionStore(root).create_session(state)
            writer = TranscriptWriter(paths.transcript_path)
            provider = FlakyProvider()

            result = TurnRunner(provider=provider, registry=ToolRegistry()).run_turn(
                "retry please",
                state=state,
                transcript_writer=writer,
            )
            records = writer.read_all()

        self.assertEqual(result.final_text, "recovered")
        self.assertEqual(provider.calls, 2)
        self.assertIn("recovery_event", [record["type"] for record in records])
