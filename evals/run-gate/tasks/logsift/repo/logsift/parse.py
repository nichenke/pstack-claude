"""Parse plain log lines of the form `<timestamp> <LEVEL> <service>: <message>`."""
import re
from dataclasses import dataclass
from datetime import datetime, timezone

LEVELS = ("DEBUG", "INFO", "WARN", "ERROR")

PLAIN = re.compile(r"^(?P<ts>\S+)\s+(?P<level>[A-Z]+)\s+(?P<service>[\w.-]+):\s?(?P<message>.*)$")


@dataclass(frozen=True)
class Record:
    timestamp: datetime
    level: str
    service: str
    message: str


def parse_timestamp(text):
    """An ISO 8601 timestamp as an aware datetime; one without an offset is taken as UTC."""
    stamp = datetime.fromisoformat(text)
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp


def parse_line(line):
    """The Record for one plain log line, or None when the line does not parse."""
    match = PLAIN.match(line.rstrip("\n"))
    if not match or match["level"] not in LEVELS:
        return None
    try:
        timestamp = parse_timestamp(match["ts"])
    except ValueError:
        return None
    return Record(timestamp, match["level"], match["service"], match["message"])
