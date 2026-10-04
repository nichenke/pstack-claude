import unittest

from slugkit import slugify


class HiddenSlugifyTest(unittest.TestCase):
    def test_reported_case(self):
        self.assertEqual(slugify("Hello -- World!"), "hello-world")

    def test_no_separator_at_ends(self):
        self.assertEqual(slugify("  spaced out  "), "spaced-out")

    def test_custom_separator_collapses(self):
        self.assertEqual(slugify("a  b__c", sep="_"), "a_b_c")

    def test_only_punctuation(self):
        self.assertEqual(slugify("!!!"), "")

    def test_existing_behaviour(self):
        self.assertEqual(slugify("café au lait"), "cafe-au-lait")


if __name__ == "__main__":
    unittest.main()
