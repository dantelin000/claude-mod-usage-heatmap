#!/bin/sh
# Every check this mod has, in the order a mistake is cheapest to find.
# tsc needs .claude-plugin/types/, which Claude Code lays the first time it
# loads the mod (a session with the mod in CLAUDE_CODE_PLUGIN_DIRS).
set -e
cd "$(dirname "$0")/.."

claude plugin validate .
if [ -f .claude-plugin/types/tsconfig.json ]; then
  tsc -p .
else
  echo "tsc skipped: .claude-plugin/types/ is laid once Claude Code has loaded the mod"
fi
claude plugin test .
python3 -m unittest discover -s tests
