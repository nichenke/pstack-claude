# logsift

Counts log records by level.

```sh
python3 -m logsift app.log other.log
cat app.log | python3 -m logsift
```

Each input line looks like `2026-09-01T12:00:00Z INFO api: request served`. Lines that do not parse are skipped. The output is one `LEVEL COUNT` line per level, most frequent first, ties broken by level name.

Run the tests with `python3 -m unittest discover -s tests -t .`.
