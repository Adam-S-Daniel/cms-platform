#!/usr/bin/env python3
"""
Auto-publish Jekyll posts whose publish_date has arrived.

Scans _posts/*.md for files where:
  - published: false
  - publish_date: <datetime> <= now (UTC)

Sets published: true on those files. Writes changed=true/false and
count=N to $GITHUB_OUTPUT when running in GitHub Actions.
"""

import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

POSTS_DIR = Path("_posts")
GITHUB_OUTPUT = os.environ.get("GITHUB_OUTPUT")

DATE_FORMATS = [
    "%Y-%m-%d %H:%M:%S %z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%d %H:%M %z",
    "%Y-%m-%d %H:%M:%S +0000",
    "%Y-%m-%d",
]


def parse_publish_date(raw: str) -> datetime | None:
    raw = raw.strip().strip("\"'")
    for fmt in DATE_FORMATS:
        try:
            dt = datetime.strptime(raw, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            return dt
        except ValueError:
            continue
    return None


def write_output(key: str, value: str) -> None:
    if GITHUB_OUTPUT:
        with open(GITHUB_OUTPUT, "a", encoding="utf-8") as f:
            f.write(f"{key}={value}\n")


def main() -> None:
    now = datetime.now(UTC)
    print(f"Checking for scheduled posts due before {now.isoformat()} …")

    changed = []

    for filepath in sorted(POSTS_DIR.glob("*.md")):
        content = filepath.read_text()

        if not re.search(r"^published:\s*false", content, re.MULTILINE):
            continue

        m = re.search(r"^publish_date:\s*(.+)$", content, re.MULTILINE)
        if not m:
            continue

        pd = parse_publish_date(m.group(1))
        if pd is None:
            print(
                f"  WARNING: could not parse publish_date in {filepath.name}: {m.group(1)!r}",
                file=sys.stderr,
            )
            continue

        if pd <= now:
            print(f"  Publishing {filepath.name}  (scheduled: {pd.isoformat()})")
            content = re.sub(r"^published:\s*false", "published: true", content, flags=re.MULTILINE)
            filepath.write_text(content)
            changed.append(filepath.name)
        else:
            delta = pd - now
            hours = int(delta.total_seconds() // 3600)
            print(f"  Skipping  {filepath.name}  (due in ~{hours}h)")

    if changed:
        print(f"\nPublished {len(changed)} post(s): {', '.join(changed)}")
        write_output("changed", "true")
        write_output("count", str(len(changed)))
    else:
        print("No posts due for publishing.")
        write_output("changed", "false")
        write_output("count", "0")


if __name__ == "__main__":
    main()
