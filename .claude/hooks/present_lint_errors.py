#!/usr/bin/env python3
"""
PostToolUse hook for Claude Code: presents lint errors to Claude
so it can intelligently fix them, rather than auto-fixing.

Runs ESLint (with JSON output) on the specific file that was just
edited, then returns any issues as additionalContext for Claude to
act on immediately.
"""

import json
import os
import subprocess
import sys


def find_edited_file(input_data: str) -> str | None:
    """Extract the file path from the PostToolUse hook input JSON."""
    try:
        context = json.loads(input_data)
    except (json.JSONDecodeError, ValueError):
        return None

    # PostToolUse for Write tool
    tool_input = context.get("tool_input", {})
    file_path = tool_input.get("file_path") or tool_input.get("path")

    if file_path:
        return file_path

    # PostToolUse for Edit tool — check tool_input
    file_path = tool_input.get("file_path")
    if file_path:
        return file_path

    return None


def run_eslint_on_file(project_dir: str, file_path: str) -> str | None:
    """Run ESLint on a single file with JSON output, return formatted summary or None."""
    try:
        result = subprocess.run(
            ["npx", "eslint", "--no-ignore", "-f", "json", file_path],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return f"ESLint on `{file_path}`: timed out after 60s"
    except FileNotFoundError:
        return None

    if result.returncode not in (0, 1):
        return None

    if not result.stdout.strip():
        return None

    try:
        reports = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    if not reports:
        return None

    report = reports[0]
    messages = report.get("messages", [])
    if not messages:
        return None

    # Make path relative
    rel_path = file_path
    if project_dir and rel_path.startswith(project_dir):
        rel_path = rel_path[len(project_dir) + 1:]

    errors = [m for m in messages if m.get("severity") == 2]
    warnings = [m for m in messages if m.get("severity") == 1]
    fixable_errors = sum(1 for m in errors if m.get("fix"))
    fixable_warnings = sum(1 for m in warnings if m.get("fix"))

    lines: list[str] = []
    for msg in messages:
        line = msg.get("line", "?")
        col = msg.get("column", "?")
        rule = msg.get("ruleId", "unknown")
        severity = "error" if msg.get("severity") == 2 else "warning"
        message_text = msg.get("message", "").split("\n")[0]
        fix_tag = " [auto-fixable]" if msg.get("fix") else ""
        lines.append(f"  L{line}:{col}  {severity}  {rule}  {message_text}{fix_tag}")

    summary = (
        f"ESLint in `{rel_path}`: "
        f"{len(errors)} error{'s' if len(errors) != 1 else ''}, "
        f"{len(warnings)} warning{'s' if len(warnings) != 1 else ''}"
    )
    if fixable_errors > 0 or fixable_warnings > 0:
        summary += (
            f" ({fixable_errors} fixable error{'s' if fixable_errors != 1 else ''}, "
            f"{fixable_warnings} fixable warning{'s' if fixable_warnings != 1 else ''})"
        )

    return summary + "\n" + "\n".join(lines)


def main() -> None:
    input_data = sys.stdin.read() if not sys.stdin.isatty() else ""

    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    file_path = find_edited_file(input_data)
    if not file_path:
        sys.exit(0)

    # Only run on relevant file types
    if not any(file_path.endswith(ext) for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")):
        sys.exit(0)

    output_text = run_eslint_on_file(project_dir, file_path)
    if not output_text:
        sys.exit(0)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PostToolUse",
            "additionalContext": (
                "Lint results for the file you just edited. "
                "Please review and fix the issues:\n\n"
                f"{output_text}"
            ),
        }
    }

    json.dump(output, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
