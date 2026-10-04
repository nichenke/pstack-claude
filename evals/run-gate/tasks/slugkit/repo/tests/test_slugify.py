import unittest

from slugkit import slugify


class SlugifyTest(unittest.TestCase):
    def test_two_words(self):
        self.assertEqual(slugify("hello world"), "hello-world")

    def test_accents(self):
        self.assertEqual(slugify("café"), "cafe")


if __name__ == "__main__":
    unittest.main()
