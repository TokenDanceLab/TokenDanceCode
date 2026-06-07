import os
import unittest

from tokendance.config.secrets import get_env_api_key


class SecretsTests(unittest.TestCase):
    def test_reads_openai_key_from_environment(self) -> None:
        old_value = os.environ.get("OPENAI_API_KEY")
        os.environ["OPENAI_API_KEY"] = "test-openai-key"
        try:
            self.assertEqual(get_env_api_key("openai"), "test-openai-key")
        finally:
            if old_value is None:
                os.environ.pop("OPENAI_API_KEY", None)
            else:
                os.environ["OPENAI_API_KEY"] = old_value

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
