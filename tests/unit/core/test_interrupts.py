import unittest

from tokendance.core.interrupts import InterruptHandler


class InterruptHandlerTests(unittest.TestCase):
    def test_returns_completed_status_when_action_finishes(self) -> None:
        handler = InterruptHandler(save_callback=lambda: None)

        status = handler.run(lambda: "done")

        self.assertEqual(status.state, "completed")
        self.assertEqual(status.result, "done")
        self.assertFalse(status.saved)

    def test_catches_keyboard_interrupt_saves_and_returns_interrupted_status(self) -> None:
        saves = []

        def action() -> str:
            raise KeyboardInterrupt

        handler = InterruptHandler(save_callback=lambda: saves.append("saved"))

        status = handler.run(action)

        self.assertEqual(saves, ["saved"])
        self.assertEqual(status.state, "interrupted")
        self.assertTrue(status.saved)
        self.assertIn("Interrupted", status.message)


if __name__ == "__main__":
    unittest.main()
