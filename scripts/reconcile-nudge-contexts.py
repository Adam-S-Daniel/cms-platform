#!/usr/bin/env python3
"""
Reconcile a consumer's cms-automerge-nudge caller with the platform manifest.

WHY THIS EXISTS (#315). `platform-bump` moves PINS, and it seeds a wholly new
thin caller. Neither of those reaches an input the platform dictates INSIDE a
caller the consumer already has. cms-platform#309 added
`prerelease-guard / prerelease-guard` to the `consumer-main` ruleset, so every
consumer's `required_contexts` went stale in the very commit that moved the pin,
reddening `e2e / e2e` on both sites; the fix had to be hand-added to each bump PR.

That input is not cosmetic. The nudge builds its whole notion of "green" from it,
so a list SHORTER than the repo's real required set asks for a merge it has not
established — jodidaniel.com#156 passed ONE of six for months, and was safe only
because `pulls.merge()` answered 405 on its behalf.

THE LIST IS DERIVED PER CONSUMER, never copied from the template: the manifest's
ruleset for THIS repo. A consumer may map `main` to some other library entry, and
imposing the template's list on it would be silently wrong. This mirrors exactly
how e2e/consumer-automerge-nudge-contexts.test.js computes what it asserts.

READ WITH A PARSER, WRITE WITH A SPLICE, THEN RE-PARSE. A line scanner is blind
to anchors and aliases, so both sides are parsed. But re-emitting the caller from
the parsed document would destroy every comment in it — including the block that
tells the next reader to DERIVE this list rather than copy it — so the write is a
splice of the block scalar's own lines. A splice nobody checks is how a mangled
workflow ships, so the result is re-parsed and compared before anything is saved.

Usage (all inputs are environment variables):
    NUDGE_PATH=.github/workflows/cms-automerge-nudge.yml \
    MANIFEST_PATH=/tmp/repo-settings.yml \
    SLUG=owner/repo \
    python3 scripts/reconcile-nudge-contexts.py

Prints exactly one line and exits:
    0  OK …       already matches, nothing to do
    0  SKIP …     nothing to reconcile against (not in the manifest, no caller)
    0  UPDATED …  the file was rewritten
    3  MANUAL …   could not be done safely; the operator must do it by hand
Any other exit code is unexpected and the caller should treat it as MANUAL.
"""

import os
import sys

NUDGE_REUSABLE_MARKER = "cms-automerge-nudge.yml@"


def nudge_job(doc):
    """The single job invoking the platform's nudge reusable, or None."""
    for job in (doc.get("jobs") or {}).values():
        if not isinstance(job, dict):
            continue
        uses = job.get("uses")
        if isinstance(uses, str) and NUDGE_REUSABLE_MARKER in uses:
            return job
    return None


def contexts_of(job):
    """The caller's `required_contexts` input as a list, one entry per line."""
    raw = (job.get("with") or {}).get("required_contexts") if job else None
    return [line.strip() for line in str(raw or "").split("\n") if line.strip()]


def desired_contexts(manifest, slug):
    """
    The contexts this repo's OWN main ruleset requires, per the manifest.

    Returns (contexts, ruleset_name) or (None, reason) — a reason means there is
    nothing to reconcile against, which is a SKIP and never a failure: a site
    that is not in `repos:` has no managed ruleset for this to mirror.
    """
    entry = (manifest.get("repos") or {}).get(slug)
    if not entry:
        return None, f"{slug} is not declared under `repos:` in the platform manifest"
    name = (entry.get("rulesets") or {}).get("main")
    if not name:
        return None, f"{slug} declares no `rulesets.main`"
    ruleset = (manifest.get("ruleset_library") or {}).get(name)
    if not ruleset:
        return None, f"`ruleset_library.{name}` is not defined in the manifest"
    rule = next(
        (
            r
            for r in (ruleset.get("rules") or [])
            if isinstance(r, dict) and r.get("type") == "required_status_checks"
        ),
        None,
    )
    if not rule:
        return None, f"`ruleset_library.{name}` carries no required_status_checks rule"
    contexts = [
        str(c["context"])
        for c in ((rule.get("parameters") or {}).get("required_status_checks") or [])
        if isinstance(c, dict) and c.get("context")
    ]
    if not contexts:
        # An empty list would tell the nudge that nothing needs to be green.
        return None, f"`ruleset_library.{name}` requires no contexts"
    return contexts, name


def splice_block_scalar(src, key, values):
    """
    Replace the `key: |` block scalar's body with `values`, touching nothing
    else in the file. Returns the new text, or None when the key is not a `|`
    block (a flow list or a folded scalar is not something to guess at).
    """
    lines = src.split("\n")
    start = None
    for i, line in enumerate(lines):
        if line.strip().startswith(f"{key}:") and line.rstrip().endswith("|"):
            start = i
            break
    if start is None:
        return None
    key_indent = len(lines[start]) - len(lines[start].lstrip())
    end = start + 1
    body_indent = None
    while end < len(lines):
        if lines[end].strip() == "":
            end += 1
            continue
        indent = len(lines[end]) - len(lines[end].lstrip())
        if indent <= key_indent:
            break
        if body_indent is None:
            body_indent = lines[end][:indent]
        end += 1
    if body_indent is None:
        body_indent = " " * (key_indent + 2)
    return "\n".join(lines[: start + 1] + [body_indent + v for v in values] + lines[end:])


def main():
    try:
        import yaml
    except ImportError:
        print("MANUAL PyYAML is unavailable, so neither side could be parsed")
        return 3

    nudge_path = os.environ.get("NUDGE_PATH", "")
    manifest_path = os.environ.get("MANIFEST_PATH", "")
    slug = os.environ.get("SLUG", "")
    if not (nudge_path and manifest_path and slug):
        print("MANUAL NUDGE_PATH, MANIFEST_PATH and SLUG must all be set")
        return 3

    try:
        with open(manifest_path, encoding="utf-8") as fh:
            manifest = yaml.safe_load(fh) or {}
        with open(nudge_path, encoding="utf-8") as fh:
            src = fh.read()
        caller = yaml.safe_load(src) or {}
    except (OSError, yaml.YAMLError) as exc:
        # Never echo a parser's dump of the document — only what went wrong.
        print(f"MANUAL could not read or parse an input ({type(exc).__name__})")
        return 3

    contexts, name = desired_contexts(manifest, slug)
    if contexts is None:
        print(f"SKIP {name}")
        return 0

    job = nudge_job(caller)
    if job is None:
        print("SKIP no job in the caller invokes the nudge reusable")
        return 0

    current = contexts_of(job)
    if sorted(current) == sorted(contexts):
        print(f"OK required_contexts already matches `ruleset_library.{name}`")
        return 0

    out = splice_block_scalar(src, "required_contexts", contexts)
    if out is None:
        print("MANUAL required_contexts is not a `|` block scalar — rewrite it by hand")
        return 3

    # The splice is only trustworthy if the parser agrees with it afterwards.
    try:
        verified = contexts_of(nudge_job(yaml.safe_load(out) or {}))
    except yaml.YAMLError:
        print("MANUAL the spliced file no longer parses — left unchanged")
        return 3
    if sorted(verified) != sorted(contexts):
        print("MANUAL the splice did not verify against the parser — left unchanged")
        return 3

    with open(nudge_path, "w", encoding="utf-8", newline="") as fh:
        fh.write(out)
    added = [c for c in contexts if c not in current]
    removed = [c for c in current if c not in contexts]
    delta = []
    if added:
        delta.append("added " + ", ".join(added))
    if removed:
        delta.append("removed " + ", ".join(removed))
    print(f"UPDATED required_contexts from `ruleset_library.{name}` ({'; '.join(delta)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
