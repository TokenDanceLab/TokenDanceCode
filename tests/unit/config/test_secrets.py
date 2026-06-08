import os
import unittest

from tokendance.config.secrets import get_env_api_key


class SecretsTests(unittest.TestCase):
    def test_unknown_provider_returns_none(self) -> None:
        self.assertIsNone(get_env_api_key("openai"))

    def test_reads_anthropic_key_from_environment(self) -> None:
        old_value = os.environ.get("ANTHROPIC_API_KEY")
        os.environ["ANTHROPIC_API_KEY"] = "test-anthropic-key"
        try:
            self.assertEqual(get_env_api_key("anthropic"), "test-anthropic-key")
        finally:
            if old_value is None:
                os.environ.pop("ANTHROPIC_API_KEY", None)
            else:
                os.environ["ANTHROPIC_API_KEY"] = old_value
