import unittest
from datetime import datetime, timezone

from logsift.parse import parse_line


class ParseLineTest(unittest.TestCase):
    def test_plain_line(self):
        record = parse_line("2026-09-01T12:00:00Z INFO api: request served\n")
        self.assertEqual(record.timestamp, datetime(2026, 9, 1, 12, tzinfo=timezone.utc))
        self.assertEqual((record.level, record.service, record.message), ("INFO", "api", "request served"))

    def test_timestamp_without_offset_is_utc(self):
        record = parse_line("2026-09-01T12:00:00 ERROR db: timeout")
        self.assertEqual(record.timestamp.tzinfo, timezone.utc)

    def test_unknown_level_does_not_parse(self):
        self.assertIsNone(parse_line("2026-09-01T12:00:00Z TRACE api: noisy"))

    def test_garbage_does_not_parse(self):
        self.assertIsNone(parse_line("not a log line"))


if __name__ == "__main__":
    unittest.main()
