import unittest

from tokendance.tools.registry import ToolRegistry
from tokendance.tools.spec import ToolContext, ToolResult, ToolSpec


def _handler(context: ToolContext, arguments: dict) -> ToolResult:
    return ToolResult.ok(content="ok")


class ToolRegistryTests(unittest.TestCase):
    def test_register_and_get_tool(self) -> None:
        registry = ToolRegistry()
        spec = ToolSpec(
            name="example",
            description="Example tool",
            input_schema={"type": "object"},
            permission_policy="read",
            handler=_handler,
        )

        registry.register(spec)

        self.assertEqual(registry.get("example"), spec)
        self.assertEqual([tool.name for tool in registry.list_tools()], ["example"])

    def test_register_rejects_duplicate_names(self) -> None:
        registry = ToolRegistry()
        spec = ToolSpec("example", "Example", {}, "read", _handler)
        registry.register(spec)

        with self.assertRaisesRegex(ValueError, "example"):
            registry.register(spec)
