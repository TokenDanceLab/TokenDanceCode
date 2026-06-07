import unittest

from tokendance.permissions.modes import VALID_PERMISSION_MODES


class PermissionModeTests(unittest.TestCase):
    def test_valid_modes_match_config_modes(self) -> None:
        self.assertEqual(
            VALID_PERMISSION_MODES,
            frozenset({"default", "safe", "auto", "yolo"}),
        )

