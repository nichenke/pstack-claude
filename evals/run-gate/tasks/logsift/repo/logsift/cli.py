import argparse
import sys

from logsift.parse import parse_line
from logsift.summarize import count_by_level


def read_lines(names):
    for name in names:
        if name == "-":
            yield from sys.stdin
        else:
            with open(name, encoding="utf-8") as handle:
                yield from handle


def main(argv=None):
    parser = argparse.ArgumentParser(prog="logsift", description="Count log records by level.")
    parser.add_argument("files", nargs="*", help="log files to read; standard input when none or '-'")
    args = parser.parse_args(argv)

    records = [record for record in map(parse_line, read_lines(args.files or ["-"])) if record]
    for level, count in count_by_level(records):
        print(f"{level} {count}")
    return 0
