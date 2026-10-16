from collections import Counter


def count_by_level(records):
    """(level, count) pairs, most frequent first, ties broken by level name."""
    counts = Counter(record.level for record in records)
    return sorted(counts.items(), key=lambda item: (-item[1], item[0]))
