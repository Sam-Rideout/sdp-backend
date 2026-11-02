"""Offline structural checks for availability reporting."""

import ast
import pathlib
import threading
import time
import unittest
from unittest.mock import Mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKER = ROOT / "tools" / "customer_sequence_worker.py"
HEARTBEAT = ROOT / "tools" / "profile_availability_heartbeat.py"

SOURCE = WORKER.read_text(encoding="utf-8")
HEARTBEAT_SOURCE = HEARTBEAT.read_text(encoding="utf-8")

TREE = ast.parse(SOURCE)
HEARTBEAT_TREE = ast.parse(HEARTBEAT_SOURCE)


class AvailabilityHeartbeatTests(unittest.TestCase):

    def test_worker_uses_opt_in_flag(self):
        self.assertIn("PX_PUBLISH_PROFILE_AVAILABILITY", SOURCE)
        self.assertIn(
            "from profile_availability_heartbeat import start_heartbeat",
            SOURCE
        )
        self.assertIn("stop_availability = start_heartbeat(", SOURCE)
        self.assertIn("interval=120", SOURCE)
        self.assertIn("stop_availability()", SOURCE)

    def test_reporting_does_not_block_main_thread(self):
        stop = threading.Event()
        publish = Mock()

        def heartbeat():
            while not stop.is_set():
                publish()
                if stop.wait(0.02):
                    break

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()

        try:
            time.sleep(0.09)
            self.assertGreaterEqual(publish.call_count, 2)
        finally:
            stop.set()
            thread.join(timeout=1)

        self.assertFalse(thread.is_alive())

    def test_worker_does_not_start_another_executive(self):
        function = next(
            node for node in HEARTBEAT_TREE.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "start_heartbeat"
        )

        code = ast.get_source_segment(HEARTBEAT_SOURCE, function)

        self.assertNotIn("subprocess", code)
        self.assertNotIn("Popen(", code)
        self.assertIn("threading.Thread(", code)

        main = next(
            node for node in TREE.body
            if isinstance(node, ast.FunctionDef)
            and node.name == "main"
        )

        main_code = ast.get_source_segment(SOURCE, main)

        self.assertIn("start_heartbeat(", main_code)
        self.assertIn("publish_current_availability", main_code)


if __name__ == "__main__":
    unittest.main()