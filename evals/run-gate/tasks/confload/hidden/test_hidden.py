import tempfile
import unittest
from pathlib import Path

from confload import load_env, load_ini


def write(text):
    handle = tempfile.NamedTemporaryFile("w", suffix=".cfg", delete=False)
    handle.write(text)
    handle.close()
    return Path(handle.name)


class HiddenConfigTest(unittest.TestCase):
    def test_ini_comments_blanks_and_quotes(self):
        text = "; c\n\n# d\n[ s ]\nK1 = \"v 1\"\nk2='v2'\nk3 = \"mismatch'\nk4 = \"\n"
        self.assertEqual(load_ini(write(text)), {"": {}, "s": {"k1": "v 1", "k2": "v2", "k3": "\"mismatch'", "k4": "\""}})

    def test_env_comments_blanks_and_quotes(self):
        text = "; c\n\nexport X=1\nY = 'two words'\nZ=\"\"\n"
        self.assertEqual(load_env(write(text)), {"x": "1", "y": "two words", "z": ""})

    def test_value_keeps_equals(self):
        self.assertEqual(load_env(write("URL=a=b\n")), {"url": "a=b"})

    def test_unquoting_written_once(self):
        source = (Path.cwd() / "confload" / "config.py").read_text()
        self.assertLessEqual(source.count("[1:-1]"), 2)


if __name__ == "__main__":
    unittest.main()
