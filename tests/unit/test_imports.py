import unittest


class ImportTests(unittest.TestCase):
    def test_package_exports_version(self) -> None:
        import tokendance

        self.assertEqual(tokendance.__version__, "0.1.0")
