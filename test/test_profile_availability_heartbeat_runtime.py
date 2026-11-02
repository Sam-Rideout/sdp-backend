"""Offline tests of the actual availability heartbeat module."""

import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from profile_availability_heartbeat import start_heartbeat


class HeartbeatRuntimeTests(unittest.TestCase):

    def test_repeats_while_main_thread_is_occupied(self):
        repeated = threading.Event()
        calls = 0

        def publish():
            nonlocal calls
            calls += 1
            if calls >= 3:
                repeated.set()

        shutdown = start_heartbeat(publish, Mock(), interval=0.02)

        try:
            self.assertTrue(
                repeated.wait(timeout=1),
                "Heartbeat did not publish repeatedly"
            )
        finally:
            self.assertTrue(shutdown(), "Heartbeat did not shut down")

    def test_publishing_error_does_not_stop_heartbeat(self):
        recovered = threading.Event()
        errors = []
        calls = 0

        def publish():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("Simulated network failure")
            recovered.set()

        shutdown = start_heartbeat(
            publish,
            errors.append,
            interval=0.02
        )

        try:
            self.assertTrue(
                recovered.wait(timeout=1),
                "Heartbeat did not recover from reporting failure"
            )
        finally:
            self.assertTrue(shutdown())

        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], RuntimeError)

    def test_shutdown_prevents_further_reporting(self):
        published = threading.Event()
        publish = Mock(side_effect=lambda: published.set())

        shutdown = start_heartbeat(
            publish,
            Mock(),
            interval=0.02
        )

        self.assertTrue(published.wait(timeout=1))
        self.assertTrue(shutdown())

        count = publish.call_count

        self.assertFalse(
            published.wait(timeout=0.05) and
            publish.call_count != count,
            "Heartbeat continued after shutdown"
        )

        self.assertEqual(publish.call_count, count)


if __name__ == "__main__":
    unittest.main()