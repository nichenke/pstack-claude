import subprocess
import sys
import unittest
from pathlib import Path

TALLY = Path(__file__).resolve().parent.parent / "tally.py"


def run(*args, stdin=""):
    return subprocess.run([sys.executable, str(TALLY), *args], input=stdin, capture_output=True, text=True, check=True).stdout


class TallyTest(unittest.TestCase):
    def test_stdin(self):
        self.assertEqual(run(stdin="one two\nthree\n"), "2 3 14 -\n")


if __name__ == "__main__":
    unittest.main()
