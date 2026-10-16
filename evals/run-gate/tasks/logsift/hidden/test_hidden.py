import gzip
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path.cwd()

PLAIN = """2026-09-01T12:00:00Z INFO api: request served
2026-09-01T12:00:01Z ERROR db: timeout
2026-09-01T12:00:02Z INFO api: request served
not a log line
2026-09-01T12:00:03Z WARN api: slow request
"""

MIXED = """2026-09-01T12:00:00Z INFO api: request served
{"ts": "2026-09-01T12:00:05Z", "level": "error", "service": "billing", "msg": "card declined"}
{"ts": 1788264010, "level": "Info", "service": "billing", "msg": "retry"}
2026-09-01T12:00:20Z warning api: slow request
{"ts": "2026-09-01T12:00:25+02:00", "level": "DEBUG", "service": "api", "msg": "cache miss"}
"""


def run(*args, stdin="", cwd=None, check=True):
    return subprocess.run(
        [sys.executable, "-m", "logsift", *args],
        cwd=cwd or ROOT,
        env={**os.environ, "PYTHONPATH": str(ROOT)},
        input=stdin,
        capture_output=True,
        text=True,
        check=check,
    )


def out(*args, **kwargs):
    return run(*args, **kwargs).stdout


def stamp(delta):
    return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")


class HiddenLogsiftTest(unittest.TestCase):
    def test_plain_table_unchanged(self):
        self.assertEqual(out(stdin=PLAIN), "INFO 2\nERROR 1\nWARN 1\n")

    def test_json_lines_mixed_with_plain(self):
        self.assertEqual(out(stdin=MIXED), "INFO 2\nDEBUG 1\nERROR 1\nWARN 1\n")

    def test_gzip_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "app.log.gz")
            with gzip.open(path, "wt", encoding="utf-8") as handle:
                handle.write(MIXED)
            self.assertEqual(out(str(path)), "INFO 2\nDEBUG 1\nERROR 1\nWARN 1\n")

    def test_since_until_timestamps(self):
        self.assertEqual(
            out("--since", "2026-09-01T12:00:05Z", "--until", "2026-09-01T12:00:20Z", stdin=MIXED),
            "ERROR 1\nINFO 1\n",
        )

    def test_offset_and_naive_bounds_compare_in_utc(self):
        self.assertEqual(out("--until", "2026-09-01T10:00:30", stdin=MIXED), "DEBUG 1\n")

    def test_relative_durations(self):
        log = "".join(
            f"{stamp(delta)} INFO api: tick\n" for delta in (timedelta(hours=3), timedelta(hours=1), timedelta(minutes=5))
        )
        self.assertEqual(out("--since", "2h", stdin=log), "INFO 2\n")
        self.assertEqual(out("--until", "30m", stdin=log), "INFO 2\n")
        self.assertEqual(out("--since", "1d", "--until", "90s", stdin=log), "INFO 3\n")

    def test_min_level_with_warning_alias(self):
        self.assertEqual(out("--min-level", "warning", stdin=MIXED), "ERROR 1\nWARN 1\n")
        self.assertEqual(out("--min-level", "INFO", stdin=MIXED), "INFO 2\nERROR 1\nWARN 1\n")

    def test_by_service(self):
        self.assertEqual(out("--by", "service", stdin=MIXED), "api 3\nbilling 2\n")

    def test_json_format(self):
        self.assertEqual(
            json.loads(out("--format", "json", stdin=MIXED)),
            [{"key": "INFO", "count": 2}, {"key": "DEBUG", "count": 1}, {"key": "ERROR", "count": 1}, {"key": "WARN", "count": 1}],
        )

    def test_json_format_empty(self):
        self.assertEqual(json.loads(out("--format", "json", "--min-level", "ERROR", stdin=PLAIN.replace("ERROR", "INFO"))), [])

    def test_csv_format(self):
        self.assertEqual(out("--format", "csv", "--by", "service", stdin=MIXED).splitlines(), ["key,count", "api,3", "billing,2"])

    def test_config_in_current_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "logsift.toml").write_text('by = "service"\nformat = "csv"\nmin_level = "WARN"\n')
            self.assertEqual(out(stdin=MIXED, cwd=tmp).splitlines(), ["key,count", "api,1", "billing,1"])

    def test_flags_win_over_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "logsift.toml").write_text('by = "service"\nformat = "csv"\n')
            self.assertEqual(out("--by", "level", "--format", "table", stdin=MIXED, cwd=tmp), "INFO 2\nDEBUG 1\nERROR 1\nWARN 1\n")

    def test_config_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp, "triage.toml")
            config.write_text('format = "json"\n')
            self.assertEqual(json.loads(out("--config", str(config), stdin=PLAIN))[0], {"key": "INFO", "count": 2})
            missing = run("--config", str(Path(tmp, "nope.toml")), stdin=PLAIN, check=False)
            self.assertNotEqual(missing.returncode, 0)

    def test_strict(self):
        result = run("--strict", stdin=PLAIN + "garbage\n", check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, "INFO 2\nERROR 1\nWARN 1\n")
        self.assertIn("2 unparseable lines", result.stderr)

    def test_without_strict_unparseable_lines_are_skipped(self):
        result = run(stdin=PLAIN, check=False)
        self.assertEqual((result.returncode, result.stderr), (0, ""))


if __name__ == "__main__":
    unittest.main()
