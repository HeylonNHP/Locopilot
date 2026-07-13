#!/usr/bin/env python3
"""
Stop hook for Claude Code: comprehensive lint + type-check at end of turn.

Runs the full project ESLint and TypeScript compiler, then returns
any issues as additionalContext so Claude can fix them before
declaring the task complete.
"""

import json
import os
import subprocess
import sys


def run_eslint_full(project_dir: str) -> str | None:
    """Run ESLint on the full project with JSON output."""
    try:
        result = subprocess.run(
            ["npx", "eslint", ".", "-f", "json"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "ESLint: timed out after 120s"
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

    total_errors = 0
    total_warnings = 0
    fixable_errors = 0
    fixable_warnings = 0
    file_lines: list[str] = []

    for report in reports:
        file_path = report.get("filePath", "")
        if project_dir and file_path.startswith(project_dir):
            file_path = file_path[len(project_dir) + 1:]

        messages = report.get("messages", [])
        if not messages:
            continue

        file_errors = sum(1 for m in messages if m.get("severity") == 2)
        file_warnings = sum(1 for m in messages if m.get("severity") == 1)
        file_fixable = sum(1 for m in messages if m.get("fix") and m.get("severity") == 2)
        file_fixable_w = sum(1 for m in messages if m.get("fix") and m.get("severity") == 1)

        total_errors += file_errors
        total_warnings += file_warnings
        fixable_errors += file_fixable
        fixable_warnings += file_fixable_w

        file_lines.append(
            f"  `{file_path}` ({file_errors} error{'s' if file_errors != 1 else ''}, "
            f"{file_warnings} warning{'s' if file_warnings != 1 else ''}):"
        )

        for msg in messages:
            line = msg.get("line", "?")
            col = msg.get("column", "?")
            rule = msg.get("ruleId", "unknown")
            severity = "error" if msg.get("severity") == 2 else "warning"
            message_text = msg.get("message", "").split("\n")[0]
            fix_tag = " [auto-fixable]" if msg.get("fix") else ""
            file_lines.append(f"    L{line}:{col}  {severity}  {rule}  {message_text}{fix_tag}")

    if total_errors == 0 and total_warnings == 0:
        return None

    summary = (
        f"ESLint: {total_errors} error{'s' if total_errors != 1 else ''}, "
        f"{total_warnings} warning{'s' if total_warnings != 1 else ''}"
    )
    if fixable_errors > 0 or fixable_warnings > 0:
        summary += (
            f" ({fixable_errors} fixable error{'s' if fixable_errors != 1 else ''}, "
            f"{fixable_warnings} fixable warning{'s' if fixable_warnings != 1 else ''})"
        )

    return summary + "\n" + "\n".join(file_lines)


def run_type_check(project_dir: str) -> str | None:
    """Run TypeScript compiler, return formatted output or None if clean."""
    try:
        result = subprocess.run(
            ["npx", "tsc", "--noEmit"],
            cwd=project_dir,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "TypeScript: timed out after 120s"
    except FileNotFoundError:
        return None

    if result.returncode == 0:
        return None

    output = (result.stdout or "") + (result.stderr or "")
    output = output.strip()
    if not output:
        return None

    error_count = output.count("error TS")
    lines = output.split("\n")
    if len(lines) > 30:
        output = "\n".join(lines[:30]) + f"\n  ... and {len(lines) - 30} more line(s)"

    return f"TypeScript ({error_count} error{'s' if error_count != 1 else ''}):\n{output}"


def main() -> None:
    project_dir = os.environ.get("CLAUDE_PROJECT_DIR", os.getcwd())

    sections: list[str] = []

    eslint_output = run_eslint_full(project_dir)
    if eslint_output:
        sections.append(eslint_output)

    tsc_output = run_type_check(project_dir)
    if tsc_output:
        sections.append(tsc_output)

    if not sections:
        sys.exit(0)

    combined = "\n\n".join(sections)

    output = {
        "hookSpecificOutput": {
            "hookEventName": "Stop",
            "additionalContext": (
                "Full project lint and type-check results. "
                "Please review and fix the issues below:\n\n"
                f"{combined}"
            ),
        }
    }

    json.dump(output, sys.stdout)
    sys.stdout.flush()


if __name__ == "__main__":
    main()
