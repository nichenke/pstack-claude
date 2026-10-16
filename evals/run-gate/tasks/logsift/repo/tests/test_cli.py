import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

LOG = """2026-09-01T12:00:00Z INFO api: request served
2026-09-01T12:00:01Z ERROR db: timeout
2026-09-01T12:00:02Z INFO api: request served
not a log line
2026-09-01T12:00:03Z WARN api: slow request
"""


def run(*args, stdin=""):
    return subprocess.run(
        [sys.executable, "-m", "logsift", *args], cwd=ROOT, input=stdin, capture_output=True, text=True, check=True
    ).stdout


class CliTest(unittest.TestCase):
    def test_stdin(self):
        self.assertEqual(run(stdin=LOG), "INFO 2\nERROR 1\nWARN 1\n")

    def test_files_add_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            one, two = Path(tmp, "one.log"), Path(tmp, "two.log")
            one.write_text(LOG)
            two.write_text("2026-09-01T13:00:00Z ERROR db: timeout\n")
            self.assertEqual(run(str(one), str(two)), "ERROR 2\nINFO 2\nWARN 1\n")


if __name__ == "__main__":
    unittest.main()
