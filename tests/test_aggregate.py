"""Tests for scripts/aggregate.py, on made-up transcripts.

Run from the repository root: python3 -m unittest discover -s tests
"""

import ast
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "aggregate.py")


def assistant(message_id, timestamp, usage, session="s1", request_id=None, model="claude-opus-5-5", block="text"):
    message = {
        "model": model,
        "type": "message",
        "role": "assistant",
        "content": [{"type": block, block: "..."}],
        "usage": {
            "input_tokens": usage[0],
            "cache_creation_input_tokens": usage[1],
            "cache_read_input_tokens": usage[2],
            "output_tokens": usage[3],
        },
    }
    if message_id is not None:
        message["id"] = message_id
    record = {
        "type": "assistant",
        "sessionId": session,
        "timestamp": timestamp,
        "message": message,
    }
    if request_id is not None:
        record["requestId"] = request_id
    return json.dumps(record)


def user(text, timestamp, session="s1"):
    return json.dumps(
        {
            "type": "user",
            "sessionId": session,
            "timestamp": timestamp,
            "message": {"role": "user", "content": text},
        }
    )


class AggregateTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.mkdtemp(prefix="usage-heatmap-test-")
        self.projects = os.path.join(self.folder, "projects")
        self.cache = os.path.join(self.folder, "cache", "aggregate.json")
        os.makedirs(self.projects)

    def tearDown(self):
        shutil.rmtree(self.folder, ignore_errors=True)

    def write(self, relative, lines, mode="w", end="\n"):
        path = os.path.join(self.projects, relative)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, mode, encoding="utf-8") as handle:
            handle.write("\n".join(lines) + end)
        return path

    def run_script(self, tz="UTC", cache=True, extra=()):
        argv = [sys.executable, "-I", SCRIPT, "--projects", self.projects]
        argv += ["--cache", self.cache] if cache else ["--no-cache"]
        argv += list(extra)
        env = dict(os.environ, TZ=tz)
        done = subprocess.run(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr.decode())
        return json.loads(done.stdout.decode())

    def test_lines_of_one_response_count_once(self):
        usage = (3, 100, 5000, 40)
        self.write(
            "-Users-dante-app/s1.jsonl",
            [
                user("hi", "2026-10-15T01:00:00.000Z"),
                assistant("msg_a", "2026-10-15T01:00:01.000Z", usage, block="thinking"),
                assistant("msg_a", "2026-10-15T01:00:02.000Z", usage, block="text"),
                assistant("msg_a", "2026-10-15T01:00:03.000Z", usage, block="tool_use"),
                assistant("msg_b", "2026-10-15T01:00:05.000Z", (1, 0, 5100, 7)),
            ],
        )
        day = self.run_script()["days"]["2026-10-15"]
        self.assertEqual(day["input"], 4)
        self.assertEqual(day["cacheWrite"], 100)
        self.assertEqual(day["cacheRead"], 10100)
        self.assertEqual(day["output"], 47)
        self.assertEqual(day["messages"], 2)
        self.assertEqual(day["sessions"], 1)

    def test_request_id_stands_in_for_a_missing_message_id(self):
        self.write(
            "p/s1.jsonl",
            [
                assistant(None, "2026-10-15T01:00:00Z", (1, 0, 0, 10), request_id="req_1"),
                assistant(None, "2026-10-15T01:00:01Z", (1, 0, 0, 10), request_id="req_1"),
                # neither id: each line is its own response
                assistant(None, "2026-10-15T01:00:02Z", (1, 0, 0, 10)),
                assistant(None, "2026-10-15T01:00:03Z", (1, 0, 0, 10)),
            ],
        )
        day = self.run_script()["days"]["2026-10-15"]
        self.assertEqual(day["messages"], 3)
        self.assertEqual(day["output"], 30)

    def test_split_lines_keep_the_largest_counts(self):
        # Should a split line ever carry a partial count, the final one wins.
        self.write(
            "p/s1.jsonl",
            [
                assistant("msg_a", "2026-10-15T01:00:00Z", (2, 10, 0, 1)),
                assistant("msg_a", "2026-10-15T01:00:01Z", (2, 10, 0, 90)),
            ],
        )
        self.assertEqual(self.run_script()["days"]["2026-10-15"]["output"], 90)

    def test_days_follow_the_local_time_zone(self):
        self.write(
            "p/s1.jsonl",
            [
                assistant("msg_late", "2026-10-14T23:30:00.000Z", (0, 0, 0, 100)),
                assistant("msg_next", "2026-10-15T15:59:59.000Z", (0, 0, 0, 10)),
                assistant("msg_after", "2026-10-15T16:00:00.000Z", (0, 0, 0, 1)),
            ],
        )
        utc = self.run_script(tz="UTC", cache=False)
        self.assertEqual(utc["utcOffsetMinutes"], 0)
        self.assertEqual(
            {day: totals["output"] for day, totals in utc["days"].items()},
            {"2026-10-14": 100, "2026-10-15": 11},
        )
        shanghai = self.run_script(tz="Asia/Shanghai", cache=False)
        self.assertEqual(shanghai["utcOffsetMinutes"], 480)
        self.assertEqual(
            {day: totals["output"] for day, totals in shanghai["days"].items()},
            {"2026-10-15": 110, "2026-10-16": 1},
        )
        los_angeles = self.run_script(tz="America/Los_Angeles", cache=False)
        self.assertEqual(
            {day: totals["output"] for day, totals in los_angeles["days"].items()},
            {"2026-10-14": 100, "2026-10-15": 11},
        )

    def test_the_cache_does_not_depend_on_the_time_zone(self):
        self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-14T23:30:00Z", (0, 0, 0, 5))])
        self.assertIn("2026-10-14", self.run_script(tz="UTC")["days"])
        again = self.run_script(tz="Asia/Shanghai")
        self.assertEqual(again["parsedFiles"], 0)
        self.assertEqual(list(again["days"]), ["2026-10-15"])

    def test_offsets_in_timestamps_are_honoured(self):
        self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-15T07:30:00+08:00", (0, 0, 0, 5))])
        self.assertEqual(list(self.run_script(tz="UTC")["days"]), ["2026-10-14"])

    def test_subagents_count_under_their_session(self):
        self.write("p/s1.jsonl", [assistant("msg_main", "2026-10-15T01:00:00Z", (1, 2, 3, 4), session="s1")])
        self.write(
            "p/s1/subagents/agent-1.jsonl",
            [assistant("msg_sub", "2026-10-15T01:05:00Z", (10, 20, 30, 40), session="s1")],
        )
        self.write("q/s2.jsonl", [assistant("msg_other", "2026-10-16T01:00:00Z", (0, 0, 0, 1), session="s2")])
        result = self.run_script()
        self.assertEqual(result["files"], 3)
        self.assertEqual(result["sessions"], 2)
        day = result["days"]["2026-10-15"]
        self.assertEqual((day["input"], day["cacheWrite"], day["cacheRead"], day["output"]), (11, 22, 33, 44))
        self.assertEqual(day["sessions"], 1)

    def test_a_subagent_without_session_id_is_placed_by_its_folder(self):
        self.write("p/s9/subagents/agent-1.jsonl", [assistant("msg_sub", "2026-10-15T01:05:00Z", (1, 0, 0, 1), session=None)])
        self.write("p/s9.jsonl", [assistant("msg_main", "2026-10-15T01:00:00Z", (1, 0, 0, 1), session=None)])
        self.assertEqual(self.run_script()["sessions"], 1)

    def test_a_response_copied_into_another_transcript_counts_once(self):
        line = assistant("msg_a", "2026-10-15T01:00:00Z", (1, 1, 1, 1), session="s1")
        self.write("p/s1.jsonl", [line])
        self.write("p/s2.jsonl", [line, assistant("msg_b", "2026-10-15T02:00:00Z", (1, 1, 1, 1), session="s2")])
        self.assertEqual(self.run_script()["days"]["2026-10-15"]["messages"], 2)

    def test_other_lines_are_left_out(self):
        self.write(
            "p/s1.jsonl",
            [
                user('{"usage": {"output_tokens": 999}}', "2026-10-15T01:00:00Z"),
                json.dumps({"type": "summary", "summary": "usage", "leafUuid": "x"}),
                '{"type": "assistant", "usage": ',  # cut short
                assistant("msg_s", "2026-10-15T01:00:00Z", (0, 0, 0, 0), model="<synthetic>"),
                assistant("msg_x", "not a time", (5, 5, 5, 5)),
                assistant("msg_ok", "2026-10-15T01:00:00Z", (0, 0, 0, 3)),
            ],
        )
        result = self.run_script()
        self.assertEqual(result["badLines"], 1)
        self.assertEqual(result["days"], {"2026-10-15": {
            "input": 0, "cacheWrite": 0, "cacheRead": 0, "output": 3, "messages": 1, "sessions": 1,
        }})

    def test_no_transcripts(self):
        empty = self.run_script()
        self.assertEqual(empty["days"], {})
        self.assertEqual(empty["sessions"], 0)
        self.assertEqual(empty["files"], 0)
        shutil.rmtree(self.projects)
        self.assertEqual(self.run_script()["days"], {})

    def test_unchanged_files_are_not_read_again(self):
        self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-15T01:00:00Z", (1, 2, 3, 4))])
        self.write("p/s2.jsonl", [assistant("msg_b", "2026-10-15T01:00:00Z", (1, 2, 3, 4), session="s2")])
        first = self.run_script()
        self.assertEqual(first["parsedFiles"], 2)
        second = self.run_script()
        self.assertEqual(second["parsedFiles"], 0)
        self.assertEqual(second["days"], first["days"])

    def test_a_grown_file_is_read_from_where_it_was_left(self):
        path = self.write(
            "p/s1.jsonl",
            [assistant("msg_a", "2026-10-15T01:00:00Z", (1, 0, 0, 10)), assistant("msg_a", "2026-10-15T01:00:01Z", (1, 0, 0, 10))],
        )
        self.run_script()
        size = os.path.getsize(path)
        added = self.write(
            "p/s1.jsonl",
            [assistant("msg_a", "2026-10-15T01:00:02Z", (1, 0, 0, 10)), assistant("msg_b", "2026-10-15T01:01:00Z", (1, 0, 0, 5))],
            mode="a",
        )
        result = self.run_script()
        self.assertEqual(result["parsedFiles"], 1)
        self.assertEqual(result["parsedBytes"], os.path.getsize(added) - size)
        day = result["days"]["2026-10-15"]
        self.assertEqual((day["messages"], day["output"]), (2, 15))
        self.assertEqual(self.run_script(cache=False)["days"], result["days"])

    def test_a_rewritten_file_is_read_whole(self):
        path = self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-15T01:00:00Z", (1, 0, 0, 10)) + " " * 80])
        self.run_script()
        self.write("p/s1.jsonl", [assistant("msg_z", "2026-10-15T01:00:00Z", (1, 0, 0, 2)) + " " * 120])
        result = self.run_script()
        self.assertEqual(result["parsedBytes"], os.path.getsize(path))
        self.assertEqual(result["days"]["2026-10-15"]["output"], 2)

    def test_a_line_being_written_counts_once_finished(self):
        whole = assistant(None, "2026-10-15T01:00:00Z", (1, 0, 0, 10))
        path = self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-15T00:59:00Z", (1, 0, 0, 1)), whole], end="")
        first = self.run_script()["days"]["2026-10-15"]
        self.assertEqual(first["messages"], 2)
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("\n" + assistant(None, "2026-10-15T01:00:01Z", (1, 0, 0, 7)) + "\n")
        second = self.run_script()["days"]["2026-10-15"]
        self.assertEqual((second["messages"], second["output"]), (3, 18))

    def test_a_broken_cache_is_ignored(self):
        self.write("p/s1.jsonl", [assistant("msg_a", "2026-10-15T01:00:00Z", (1, 2, 3, 4))])
        os.makedirs(os.path.dirname(self.cache))
        with open(self.cache, "w") as handle:
            handle.write("{not json")
        self.assertEqual(self.run_script()["days"]["2026-10-15"]["output"], 4)

    def test_the_script_parses_as_python_3_8(self):
        with open(SCRIPT, encoding="utf-8") as handle:
            ast.parse(handle.read(), feature_version=(3, 8))


if __name__ == "__main__":
    unittest.main()
