import tempfile
import unittest
from pathlib import Path

from confload import load_env, load_ini


def write(text):
    handle = tempfile.NamedTemporaryFile("w", suffix=".cfg", delete=False)
    handle.write(text)
    handle.close()
    return Path(handle.name)


class ConfigTest(unittest.TestCase):
    def test_ini_sections(self):
        self.assertEqual(load_ini(write("top=1\n[db]\nHost = 'x'\n")), {"": {"top": "1"}, "db": {"host": "x"}})

    def test_env_export(self):
        self.assertEqual(load_env(write('export A="b"\n# c\n')), {"a": "b"})


if __name__ == "__main__":
    unittest.main()
