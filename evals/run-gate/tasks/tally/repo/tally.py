#!/usr/bin/env python3
"""Count lines, words and characters in files or standard input."""
import argparse
import sys


def count(text):
    return len(text.splitlines()), len(text.split()), len(text)


def main(argv=None):
    parser = argparse.ArgumentParser(prog="tally")
    parser.add_argument("files", nargs="*", help="files to count; standard input when none")
    args = parser.parse_args(argv)

    inputs = args.files or ["-"]
    for name in inputs:
        if name == "-":
            text = sys.stdin.read()
        else:
            with open(name, encoding="utf-8") as handle:
                text = handle.read()
        lines, words, chars = count(text)
        print(f"{lines} {words} {chars} {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
