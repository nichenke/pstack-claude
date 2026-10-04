import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TALLY = Path.cwd() / "tally.py"


def run(*args, stdin=""):
    return subprocess.run([sys.executable, str(TALLY), *args], input=stdin, capture_output=True, text=True, check=True).stdout


class HiddenTallyTest(unittest.TestCase):
    def test_json_stdin(self):
        self.assertEqual(json.loads(run("--json", stdin="a b\nc\n")), [{"file": "-", "lines": 2, "words": 3, "chars": 6}])

    def test_json_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            one, two = Path(tmp, "one.txt"), Path(tmp, "two.txt")
            one.write_text("x\n")
            two.write_text("y z\nw\n")
            out = json.loads(run("--json", str(one), str(two)))
        self.assertEqual([entry["file"] for entry in out], [str(one), str(two)])
        self.assertEqual([(e["lines"], e["words"], e["chars"]) for e in out], [(1, 1, 2), (2, 3, 6)])

    def test_plain_unchanged(self):
        self.assertEqual(run(stdin="one two\nthree\n"), "2 3 14 -\n")


if __name__ == "__main__":
    unittest.main()
