#!/usr/bin/env python3
"""Sum Claude Code token usage per local day, for the usage-heatmap mod.

Reads every transcript under ~/.claude/projects (subagents' included), keeps
one row per API response (a response is split over several lines that carry
the same usage, so lines are merged by message.id, else requestId) and prints
one JSON object of per-day totals on stdout.

A cache keyed by path, size and mtime keeps what each file held, so a later
run reparses only the files that changed, and reads only the appended tail of
a file that grew. Timestamps are kept in the cache as epoch seconds and put in
days only at the end, in the local time zone (the TZ environment variable,
else the system's), so the cache does not depend on the zone.

Runs on Python 3.8 and later (macOS ships 3.9 as /usr/bin/python3), standard
library only. Invoked as `python3 -I aggregate.py [--projects DIR]...
[--cache PATH | --no-cache]`.
"""

import argparse
import calendar
import json
import os
import re
import sys
import time

CACHE_VERSION = 1
TAIL_BYTES = 64
USAGE_MARK = b'"usage"'
TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?"
    r"(Z|[+-]\d{2}:?\d{2})?$"
)


def default_config_dir():
    configured = os.environ.get("CLAUDE_CONFIG_DIR")
    if configured:
        return os.path.expanduser(configured)
    return os.path.join(os.path.expanduser("~"), ".claude")


def default_cache_path():
    base = os.environ.get("XDG_CACHE_HOME")
    if not base:
        home = os.path.expanduser("~")
        if sys.platform == "darwin":
            base = os.path.join(home, "Library", "Caches")
        else:
            base = os.path.join(home, ".cache")
    return os.path.join(base, "claude-usage-heatmap", "aggregate-v%d.json" % CACHE_VERSION)


def parse_timestamp(text):
    """ISO 8601 to epoch seconds; None when it does not parse."""
    if not isinstance(text, str):
        return None
    match = TIMESTAMP.match(text.strip())
    if match is None:
        return None
    year, month, day, hour, minute, second = (int(match.group(i)) for i in range(1, 7))
    zone = match.group(7)
    try:
        seconds = calendar.timegm((year, month, day, hour, minute, second, 0, 0, 0))
    except (OverflowError, ValueError):
        return None
    if zone and zone != "Z":
        sign = -1 if zone[0] == "-" else 1
        digits = zone[1:].replace(":", "")
        seconds -= sign * (int(digits[:2]) * 3600 + int(digits[2:]) * 60)
    return seconds


def as_count(value):
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)) and value > 0:
        return int(value)
    return 0


def session_of_path(path):
    """The session a transcript belongs to, by its place on disk."""
    parts = path.replace("\\", "/").split("/")
    if "subagents" in parts:
        index = parts.index("subagents")
        if index > 0:
            return parts[index - 1]
    name = parts[-1]
    return name[:-6] if name.endswith(".jsonl") else name


def read_entry(line):
    """One usage row from a transcript line, or None.

    The row is [key, epoch, input, cacheWrite, cacheRead, output, session]; the
    key is message.id, else requestId, else None (counted as its own).
    """
    if USAGE_MARK not in line:
        return None
    try:
        record = json.loads(line)
    except ValueError:
        return False
    if not isinstance(record, dict) or record.get("type") != "assistant":
        return None
    message = record.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None
    if message.get("model") == "<synthetic>":
        return None
    epoch = parse_timestamp(record.get("timestamp"))
    if epoch is None:
        return None
    key = message.get("id") or record.get("requestId") or None
    if key is not None and not isinstance(key, str):
        key = str(key)
    counts = [
        as_count(usage.get("input_tokens")),
        as_count(usage.get("cache_creation_input_tokens")),
        as_count(usage.get("cache_read_input_tokens")),
        as_count(usage.get("output_tokens")),
    ]
    session = record.get("sessionId")
    if not isinstance(session, str):
        session = None
    return [key, epoch] + counts + [session]


def merge_into(rows, row):
    """Adds a row to a dict of rows by key: the earliest time, each count's max."""
    key = row[0]
    held = rows.get(key)
    if held is None:
        rows[key] = row
        return
    held[1] = min(held[1], row[1])
    for i in range(2, 6):
        if row[i] > held[i]:
            held[i] = row[i]
    if held[6] is None:
        held[6] = row[6]


def parse_lines(data, base, rows, stats):
    """Parses the complete lines of `data`, the file's bytes from offset
    `base` on, into `rows`; returns the bytes consumed (through the last
    newline). A row with no key is keyed by its line's offset in the file."""
    consumed = data.rfind(b"\n") + 1
    start = 0
    while start < consumed:
        end = data.index(b"\n", start)
        line = data[start:end]
        if line.strip():
            entry = read_entry(line)
            if entry is False:
                stats["badLines"] += 1
            elif entry is not None:
                if entry[0] is None:
                    entry[0] = "#%d" % (base + start)
                merge_into(rows, entry)
        start = end + 1
    rest = data[consumed:]
    if rest.strip():
        # A last line still being written: counted now if it parses, and read
        # again next run from `consumed`, where its key keeps it counted once.
        entry = read_entry(rest)
        if entry:
            if entry[0] is None:
                entry[0] = "#%d" % (base + consumed)
            merge_into(rows, entry)
    return consumed


def scan_file(path, held, stats):
    """The cache record for `path`, reusing `held` where the file allows."""
    try:
        info = os.stat(path)
    except OSError:
        stats["errors"] += 1
        return None
    size, mtime = info.st_size, int(info.st_mtime_ns)
    if held and held.get("size") == size and held.get("mtime") == mtime:
        return held
    try:
        with open(path, "rb") as handle:
            offset = held.get("offset", 0) if held else 0
            tail = held.get("tail", "") if held else ""
            rows = {}
            start = 0
            if held and 0 < offset <= size:
                handle.seek(max(0, offset - TAIL_BYTES))
                if handle.read(min(offset, TAIL_BYTES)).hex() == tail:
                    for row in held.get("rows", []):
                        rows[row[0]] = list(row)
                    start = offset
                else:
                    rows = {}
            handle.seek(start)
            data = handle.read()
    except OSError:
        stats["errors"] += 1
        return None
    stats["parsedFiles"] += 1
    stats["parsedBytes"] += len(data)
    consumed = start + parse_lines(data, start, rows, stats)
    head = data[: consumed - start]
    if consumed - start >= TAIL_BYTES:
        tail = head[-TAIL_BYTES:].hex()
    else:
        with open(path, "rb") as handle:
            handle.seek(max(0, consumed - TAIL_BYTES))
            tail = handle.read(min(consumed, TAIL_BYTES)).hex()
    return {
        "size": size,
        "mtime": mtime,
        "offset": consumed,
        "tail": tail,
        "session": session_of_path(path),
        "rows": sorted(rows.values(), key=lambda row: (row[1], row[0])),
    }


def find_transcripts(roots):
    found = []
    for root in roots:
        if not os.path.isdir(root):
            continue
        for folder, folders, files in os.walk(root):
            folders.sort()
            for name in sorted(files):
                if name.endswith(".jsonl"):
                    found.append(os.path.join(folder, name))
    return found


def load_cache(path):
    if not path:
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            cache = json.load(handle)
    except (OSError, ValueError):
        return {}
    if not isinstance(cache, dict) or cache.get("version") != CACHE_VERSION:
        return {}
    files = cache.get("files")
    return files if isinstance(files, dict) else {}


def save_cache(path, files):
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        temporary = "%s.%d.tmp" % (path, os.getpid())
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump({"version": CACHE_VERSION, "files": files}, handle, separators=(",", ":"))
        os.replace(temporary, path)
    except OSError:
        pass


def local_day(epoch):
    moment = time.localtime(epoch)
    return "%04d-%02d-%02d" % (moment.tm_year, moment.tm_mon, moment.tm_mday)


def aggregate(roots, cache_path):
    started = time.time()
    stats = {"errors": 0, "badLines": 0, "parsedFiles": 0, "parsedBytes": 0}
    held = load_cache(cache_path)
    files = {}
    for path in find_transcripts(roots):
        record = scan_file(path, held.get(path), stats)
        if record is not None:
            files[path] = record
    save_cache(cache_path, files)

    # One response may sit in several files (a resumed session copies its
    # history): merged by key across files too, the earliest file first.
    merged = {}
    for path in sorted(files):
        record = files[path]
        for row in record["rows"]:
            key = row[0]
            if key.startswith("#"):
                key = "%s%s" % (path, key)
            entry = list(row)
            entry[0] = key
            if entry[6] is None:
                entry[6] = record["session"]
            merge_into(merged, entry)

    days = {}
    day_sessions = {}
    sessions = set()
    for row in merged.values():
        day = local_day(row[1])
        totals = days.get(day)
        if totals is None:
            totals = days[day] = {
                "input": 0,
                "cacheWrite": 0,
                "cacheRead": 0,
                "output": 0,
                "messages": 0,
                "sessions": 0,
            }
        totals["input"] += row[2]
        totals["cacheWrite"] += row[3]
        totals["cacheRead"] += row[4]
        totals["output"] += row[5]
        totals["messages"] += 1
        day_sessions.setdefault(day, set()).add(row[6])
        sessions.add(row[6])
    for day, names in day_sessions.items():
        days[day]["sessions"] = len(names)

    now = time.time()
    return {
        "version": 1,
        "generatedAt": int(now * 1000),
        "utcOffsetMinutes": int(time.localtime(now).tm_gmtoff // 60),
        "days": dict(sorted(days.items())),
        "sessions": len(sessions),
        "files": len(files),
        "parsedFiles": stats["parsedFiles"],
        "parsedBytes": stats["parsedBytes"],
        "badLines": stats["badLines"],
        "errors": stats["errors"],
        "elapsedMs": int((time.time() - started) * 1000),
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--projects",
        action="append",
        help="a folder of transcripts (repeatable); default <config dir>/projects",
    )
    parser.add_argument("--cache", help="the cache file; default under the user cache folder")
    parser.add_argument("--no-cache", action="store_true", help="read every file, write no cache")
    args = parser.parse_args(argv)
    roots = args.projects or [os.path.join(default_config_dir(), "projects")]
    cache_path = None if args.no_cache else (args.cache or default_cache_path())
    result = aggregate([os.path.expanduser(root) for root in roots], cache_path)
    sys.stdout.write(json.dumps(result, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
