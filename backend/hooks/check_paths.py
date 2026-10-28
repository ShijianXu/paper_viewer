"""Claude Code PreToolUse hook: keep Write/Edit/NotebookEdit inside the session folder.

Usage (set up by the backend): check_paths.py <session_folder>
Reads the hook event as JSON on stdin. Exit code 2 blocks the tool call, and
the message on stderr is shown to Claude so it can try something else.
"""

import json
import os
import sys

PROTECTED = {"paper.pdf"}


def main() -> int:
    root = os.path.realpath(sys.argv[1])
    event = json.load(sys.stdin)
    tool_input = event.get("tool_input") or {}
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not path:
        return 0

    cwd = event.get("cwd") or root
    target = os.path.realpath(os.path.join(cwd, os.path.expanduser(path)))

    if os.path.commonpath([root, target]) != root:
        print(
            f"Blocked: {path} is outside the session folder ({root}). "
            "You may only create or change files inside that folder.",
            file=sys.stderr,
        )
        return 2
    if os.path.relpath(target, root) in PROTECTED:
        print("Blocked: paper.pdf is the user's paper and must not be modified.", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
