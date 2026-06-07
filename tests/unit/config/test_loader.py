import tempfile
import unittest
from pathlib import Path

from tokendance.config.loader import load_config
from tokendance.config.models import TokendanceConfig


class ConfigLoaderTests(unittest.TestCase):
    def test_loads_builtin_defaults(self) -> None:
        config = load_config()

        self.assertEqual(config, TokendanceConfig())

    def test_project_config_overrides_global_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            global_config = root / "global.toml"
            project_config = root / "project.toml"
            global_config.write_text(
                'provider = "openai"\nmodel = "gpt-5.4"\npermission_mode = "safe"\n',
                encoding="utf-8",
            )
            project_config.write_text(
                'model = "claude-sonnet-4-5"\npermission_mode = "auto"\n',
                encoding="utf-8",
            )

            config = load_config(
                global_config_path=global_config,
                project_config_path=project_config,
            )

        self.assertEqual(config.provider, "openai")
        self.assertEqual(config.model, "claude-sonnet-4-5")
        self.assertEqual(config.permission_mode, "auto")

    def test_cli_overrides_have_highest_priority(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            project_config = Path(tmp) / "project.toml"
            project_config.write_text(
                'provider = "anthropic"\nmodel = "claude-sonnet-4-5"\n',
                encoding="utf-8",
            )

            config = load_config(
                project_config_path=project_config,
                cli_overrides={"provider": "openai", "model": "gpt-5.4"},
            )

        self.assertEqual(config.provider, "openai")
        self.assertEqual(config.model, "gpt-5.4")

    def test_unknown_config_field_raises_clear_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            config_path = Path(tmp) / "config.toml"
            config_path.write_text('unknown_field = "surprise"\n', encoding="utf-8")

            with self.assertRaisesRegex(ValueError, "unknown_field"):
                load_config(project_config_path=config_path)
