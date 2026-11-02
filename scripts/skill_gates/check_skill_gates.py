#!/usr/bin/env python3
"""check_skill_gates.py — enforce the cms-platform bundle's skill graduation
and touch gates on a pull request, from what the pull request itself records.

Why this exists
----------------
The header of docs/skill-impact.md states the rules for any change to a skill
under `skills/` (AGENTS.md "Skill changes are recorded, and evals gate them"
points there):

- every skill-content change appends an entry to docs/skill-impact.md, in the
  same pull request;
- graduation gate: a new skill ships with a green `with_skill` arm;
- touch gate: a pull request that edits an existing SKILL.md runs that
  skill's eval or adds its first fixture, unless the skill is in
  skills-evals' deliberate non-coverage table;
- a removal has a `remove` entry; a renamed skill directory is a create plus
  a remove, each with its own entry;
- docs/skill-impact.md is append-only: a wrong entry, a later eval result or
  an Outcome update is a new entry.

Until this script they were prose only, and the impact log shows edits landing
with "Eval: outstanding" (Adam-S-Daniel/adam-agentskills#66 item 3, "Both
registries"; Adam-S-Daniel/skills-evals#60). This is a port of
adam-agentskills' scripts/check_skill_gates.py (adam-agentskills#97) to this
repository's layout: skills are `skills/<skill>/SKILL.md` with no plugin
level, and the one bundle is `cms-platform`. Two of the source's rules are
deliberately not ported: this repository has no PURPOSE.md convention, and
no machine-bound bundle whose new skills may graduate as `exempt`.

It does not dispatch an eval run. Evals run through skills-evals' eval
routine, not on API credit, and take minutes per arm; a required check that
ran them would be slow, costly and flaky. The gate checks the recorded
result instead: the `- Eval:` line of the pull request's new impact entry.

What it diffs
--------------
`git merge-base <base> <head>`, never `<base>` itself: a `<base>` ahead of
where the branch forked would otherwise attribute the base's own later skill
edits (and their impact entries) to the branch. In CI, self-ci.yml passes
`--base HEAD^1 --head HEAD` on the pull request's merge commit (the base tip
and the merge result), so the merge-base is HEAD^1 by construction and a
`fetch-depth: 2` checkout is enough (cms-platform#541). Locally,
`--base origin/main --head HEAD` works the same way. A merge-base that cannot
be resolved (a shallow checkout, an unknown sha) exits 2 with a named error
rather than guessing. Every file is read from the git object
store (`git show <rev>:<path>`), never from the working tree.

Only `skills/<skill>/SKILL.md` counts: create (absent at the merge-base,
present at head), remove (the reverse), touch (present at both, blob
differs). A renamed skill directory is a create plus a remove.

How entries are read
---------------------
docs/skill-impact.md is parsed with markdown-it-py, never scanned line by
line: an entry is an h2 heading `<YYYY-MM-DD> — cms-platform/<skills> —
<kind>` plus everything up to the next h2 (a trailing `---` separator
excluded), so the example heading inside the "Entry format" code fence is a
`fence` token and is never read as an entry. `<skills>` is one skill name, a
comma-separated list of them (`a, b`), or an aggregate such as `(13 skills)`,
which is a valid entry that names no skill and so satisfies no gate. A
`rename` entry naming `old → new` is not a form this check reads: record a
rename as a `create` and a `remove` entry. A NEW h2
that starts with a date but does not have that shape fails, naming the
heading. The Eval text is the inline content of the list item that starts
with `Eval:` (a wrapped bullet's continuation lines are the same inline
token). An entry is new when its heading plus body does not appear as an
entry at the merge-base.

The census, and "missing data never blocks"
--------------------------------------------
Whether a touched skill is covered, deliberately skipped or a gap comes from
skills-evals' coverage census, `coverage/latest.json` on its
`persistent/eval-results` branch, registry `cms-platform` (`--census`
overrides the source; `none` disables it). When the census cannot be read, or
does not name the skill, a touch whose Eval line carries no evidence is a
warning, not a failure: a missing census must not wedge every skill PR. The
create and remove gates never consult it (a brand-new skill is never in it).

Accepted Eval forms
--------------------
- RAN: a pass count such as `21/21` or a routine run id such as
  `20261026T211234Z-1b7681`, and the line does not negate it.
- A negation anywhere in the line (`none` at its start, `not run`, `not yet
  run`, `never run`, `did not run`, `no run`, `nothing run`, `not exempt`,
  `outstanding`, `skipped` other than `judge skipped`) voids RAN, EXEMPT and
  GREEN for that line;
  FIRST_FIXTURE still counts (`not run; first fixture in ...` is the natural
  gap form).
- FIRST_FIXTURE: a skills-evals pull request link (`skills-evals/pull/N`) or
  the path `evals/<skill>/`.
- EXEMPT: the word `exempt`.
- GREEN (graduation): `with_skill ... X/Y` and `without_skill ... A/B` with
  X > 0 and X/Y >= A/B, plus a run id or a results link.

touch, census `covered`: RAN. `skipped`: RAN or EXEMPT. `gap`: RAN or
FIRST_FIXTURE. create: GREEN. remove: a `remove` entry.

skills-evals' retirement pull requests (`retire-skill/<skill>`,
scripts/retire_skill.py) write a `remove` entry and pass as written; the
tests pin that format.

Warn-only mode
---------------
`--warn-only` reports every failure as a warning and always exits 0, even
when the check could not run (exit 2 otherwise) or crashed. self-ci.yml runs
it that way for now; dropping the flag makes it enforcing. When
`$GITHUB_STEP_SUMMARY` is set, the findings are also written there as
Markdown, in both modes.

Usage:
  python3 scripts/skill_gates/check_skill_gates.py --base <rev> --head <rev> \\
      [--census <path|https-url|none>] [--warn-only]

Exit 0: every rule met (warnings may print), or `--warn-only`. Exit 1: one or
more failures, all listed. Exit 2: the check could not run (git error,
unresolvable merge-base).
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from fractions import Fraction
from typing import Dict, List, Optional, Tuple

from markdown_it import MarkdownIt

DEFAULT_CENSUS = ("https://raw.githubusercontent.com/Adam-S-Daniel/skills-evals/"
                  "persistent/eval-results/coverage/latest.json")
CENSUS_TIMEOUT_SECONDS = 15
CENSUS_MAX_BYTES = 5 * 1024 * 1024
REGISTRY_NAME = "cms-platform"
BUNDLE = "cms-platform"
IMPACT_FILE = "docs/skill-impact.md"
KINDS = ("create", "edit", "rename", "remove", "rejected")

_GIT_VERBATIM = ("-c", "core.autocrlf=false", "-c", "core.eol=lf")
_SKILL_PATH = re.compile(r"^skills/([^/]+)/SKILL\.md$")
# Lexical patterns over one already-parsed heading's inline text.
_DATED = re.compile(r"^\d{4}-\d{2}-\d{2}\s")
_ENTRY_HEADING = re.compile(
    r"^(\d{4}-\d{2}-\d{2}) — ([^/\s]+)/(.+?) — ([A-Za-z]+)\b")
_SKILL_NAME = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_AGGREGATE = re.compile(r"^\(\d+ skills\)$")

# Lexical tokens inside one already-parsed Eval text.
_COUNT = re.compile(r"(?<![\d.])(\d+)/(\d+)(?!\d|\.\d)")
_RUN_ID = re.compile(r"\b\d{8}T\d{6}Z(?:-[0-9a-f]{6})?\b")
_NEGATION = re.compile(
    r"^[\s`]*none\b"
    r"|\b(?:not|never)(?:\s+(?:yet|been|re-?run|be))*\s+(?:re-?)?run\b"
    r"|n't(?:\s+(?:yet|been))*\s+(?:re-?)?run\b"
    r"|\b(?:nothing|no)\s+(?:evals?\s+)?(?:re-?)?run\b"
    r"|\bnot\s+exempt\b"
    r"|\boutstanding\b"
    r"|(?<!judge )\bskipped\b",
    re.IGNORECASE)
_EVALS_PR = re.compile(r"skills-evals/pull/\d+")
_EXEMPT = re.compile(r"\bexempt\b", re.IGNORECASE)
_RESULTS_LINK = re.compile(r"https://\S*eval-results\S*")
# `with_skill`, optional backticks, up to three short words (`objective`,
# `scored`), then the count.
_ARM = r"(?<![A-Za-z_]){arm}`?(?:[\s`:]+[A-Za-z]+){{0,3}}[\s`:]+(\d+)/(\d+)(?!\d|\.\d)"
_WITH = re.compile(_ARM.format(arm="with_skill"))
_WITHOUT = re.compile(_ARM.format(arm="without_skill"))


class GateError(Exception):
    """The check could not run at all (exit 2)."""


# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------

def _git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *_GIT_VERBATIM, *args],
                          capture_output=True, text=True, encoding="utf-8")


def merge_base(base: str, head: str) -> str:
    proc = _git("merge-base", base, head)
    if proc.returncode != 0 or not proc.stdout.strip():
        why = proc.stderr.strip() or f"exit {proc.returncode}"
        raise GateError(f"git merge-base {base} {head} failed: {why}. The checkout may "
                        "be shallow (CI needs fetch-depth: 0) or a revision is unknown.")
    return proc.stdout.strip()


def skill_blobs(rev: str) -> Dict[str, str]:
    """{skill: blob sha of its SKILL.md} for every skills/<skill>/SKILL.md at rev."""
    proc = _git("ls-tree", "-r", "-z", rev, "--", "skills")
    if proc.returncode != 0:
        raise GateError(f"git ls-tree {rev} failed: {proc.stderr.strip()}")
    blobs = {}
    for record in proc.stdout.split("\0"):
        meta, _, path = record.partition("\t")
        parts = meta.split()
        m = _SKILL_PATH.match(path)
        if len(parts) == 3 and parts[1] == "blob" and m:
            blobs[m.group(1)] = parts[2]
    return blobs


def show(rev: str, path: str) -> Optional[str]:
    """File content at rev, or None when the path does not exist there."""
    if _git("cat-file", "-e", f"{rev}:{path}").returncode != 0:
        return None
    proc = _git("show", f"{rev}:{path}")
    if proc.returncode != 0:
        raise GateError(f"git show {rev}:{path} failed: {proc.stderr.strip()}")
    return proc.stdout


def blob_id(rev: str, path: str) -> Optional[str]:
    proc = _git("rev-parse", "--verify", "-q", f"{rev}:{path}")
    return proc.stdout.strip() if proc.returncode == 0 else None


# ---------------------------------------------------------------------------
# docs/skill-impact.md
# ---------------------------------------------------------------------------

def _parse_heading(heading: str) -> Tuple[Optional[dict], Optional[str]]:
    """(fields, None) for an entry heading, (None, why) for a dated heading of
    the wrong shape, (None, None) for any other h2 (a section title)."""
    if not _DATED.match(heading):
        return None, None
    m = _ENTRY_HEADING.match(heading)
    if not m:
        return None, "is not `YYYY-MM-DD — <bundle>/<skill> — <kind>`"
    date, bundle, names, kind = m.groups()
    kind = kind.lower()
    if kind not in KINDS:
        return None, f"has kind `{kind}`, not one of {', '.join(KINDS)}"
    names = names.strip()
    if _AGGREGATE.match(names):
        skills: List[str] = []
    else:
        skills = [s.strip() for s in names.split(",")]
        bad = [s for s in skills if not _SKILL_NAME.match(s)]
        if bad:
            hint = ("; a rename is a `create` entry for the new name plus a `remove` entry "
                    "for the old one" if any("→" in s or "->" in s for s in bad)
                    else " (list several as `a, b`)")
            return None, (f"names {', '.join(repr(s) for s in bad)}, not a skill directory "
                          f"name{hint}")
    return {"date": date, "bundle": bundle, "skills": skills, "kind": kind}, None


def parse_entries(src: str) -> Tuple[List[dict], List[dict]]:
    """(entries, malformed), both in document order. An entry is
    {heading, date, bundle, skills, kind, body, eval}; a malformed one is a
    dated h2 of the wrong shape, {heading, body, why}."""
    if not src:
        return [], []
    lines = src.split("\n")
    tokens = MarkdownIt("commonmark").parse(src)
    h2 = []  # (heading token index, start line, end-of-heading line)
    for i, t in enumerate(tokens):
        if t.type == "heading_open" and t.tag == "h2" and t.map:
            h2.append((i, t.map[0], t.map[1]))
    hr_lines = [t.map for t in tokens if t.type == "hr" and t.map]
    entries, malformed = [], []
    for n, (i, start, after) in enumerate(h2):
        heading = tokens[i + 1].content.strip()
        fields, why = _parse_heading(heading)
        if fields is None and why is None:
            continue
        end = h2[n + 1][1] if n + 1 < len(h2) else len(lines)
        # A trailing `---` (an hr token, followed only by blank lines) is the
        # separator between entries, not part of this one.
        inside = [hr for hr in hr_lines if after <= hr[0] < end]
        if inside and all(not ln.strip() for ln in lines[inside[-1][1]:end]):
            end = inside[-1][0]
        body = "\n".join(lines[after:end]).rstrip()
        if fields is None:
            malformed.append({"heading": heading, "body": body, "why": why})
            continue
        token_end = h2[n + 1][0] if n + 1 < len(h2) else len(tokens)
        eval_text = None
        depth = 0
        for t in tokens[i + 2:token_end]:
            if t.type == "list_item_open":
                depth += 1
            elif t.type == "list_item_close":
                depth -= 1
            elif (t.type == "inline" and depth > 0 and eval_text is None
                  and t.content.lstrip().startswith("Eval:")):
                eval_text = t.content.strip()[len("Eval:"):].strip()
        entries.append(dict(fields, heading=heading, body=body, eval=eval_text or ""))
    return entries, malformed


def identity(entry: dict) -> str:
    return entry["heading"] + "\n" + entry["body"]


def new_entries(head: List[dict], base: List[dict]) -> List[dict]:
    seen = {identity(e) for e in base}
    return [e for e in head if identity(e) not in seen]


def append_only_violations(head: List[dict], base: List[dict]) -> List[str]:
    """Headings of merge-base entries no longer present byte for byte at head
    (multiset membership; order is not enforced)."""
    counts: Dict[str, int] = {}
    for e in head:
        counts[identity(e)] = counts.get(identity(e), 0) + 1
    lost = []
    for e in base:
        key = identity(e)
        if counts.get(key, 0) > 0:
            counts[key] -= 1
        else:
            lost.append(e["heading"])
    return lost


# ---------------------------------------------------------------------------
# Eval evidence
# ---------------------------------------------------------------------------

def is_negated(text: str) -> bool:
    return bool(_NEGATION.search(text))


def is_ran(text: str) -> bool:
    return bool(not is_negated(text) and (_COUNT.search(text) or _RUN_ID.search(text)))


def is_first_fixture(text: str, skill: str) -> bool:
    return bool(_EVALS_PR.search(text) or f"evals/{skill}/" in text)


def is_exempt(text: str) -> bool:
    return bool(not is_negated(text) and _EXEMPT.search(text))


def is_green(text: str) -> bool:
    if is_negated(text):
        return False
    w, wo = _WITH.search(text), _WITHOUT.search(text)
    if not w or not wo:
        return False
    x, y, a, b = (int(v) for v in (*w.groups(), *wo.groups()))
    if x <= 0 or y <= 0 or b <= 0 or x > y or a > b:
        return False
    if Fraction(x, y) < Fraction(a, b):
        return False
    return bool(_RUN_ID.search(text) or _RESULTS_LINK.search(text))


# ---------------------------------------------------------------------------
# census
# ---------------------------------------------------------------------------

def load_census(source: str) -> Tuple[Optional[Dict[str, List[dict]]], Optional[str]]:
    """({skill: [rows]} for registry cms-platform, None) or (None, why)."""
    try:
        if source.startswith("https://"):
            with urllib.request.urlopen(source, timeout=CENSUS_TIMEOUT_SECONDS) as resp:
                raw = resp.read(CENSUS_MAX_BYTES + 1)
        else:
            with open(source, "rb") as fh:
                raw = fh.read(CENSUS_MAX_BYTES + 1)
        if len(raw) > CENSUS_MAX_BYTES:
            return None, "larger than the size cap"
        doc = json.loads(raw.decode("utf-8"))
    except Exception as exc:  # any fetch or parse failure is "unreadable"
        return None, type(exc).__name__
    if not isinstance(doc, dict) or doc.get("schema") != 1:
        return None, "not schema 1"
    for reg in doc.get("registries") or []:
        if isinstance(reg, dict) and reg.get("name") == REGISTRY_NAME:
            rows: Dict[str, List[dict]] = {}
            for row in reg.get("skills") or []:
                if isinstance(row, dict) and isinstance(row.get("skill"), str):
                    rows.setdefault(row["skill"], []).append(row)
            return rows, None
    return None, f"no `{REGISTRY_NAME}` registry"


def census_status(census, skill: str) -> Optional[str]:
    if census is None:
        return None
    rows = census.get(skill) or []
    # This registry's rows carry `bundle: null` today; prefer an exact bundle
    # match should the census ever fill it in.
    exact = [r for r in rows if r.get("bundle") == BUNDLE] or rows
    status = exact[0].get("status") if exact else None
    return status if isinstance(status, str) else None


# ---------------------------------------------------------------------------
# the gates
# ---------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.failures: List[str] = []
        self.warnings: List[str] = []

    def fail(self, who: str, what: str, why: str, fix: str) -> None:
        self.failures.append(f"skill-gates: {who}: {what}. {why}. {fix}")

    def warn(self, who: str, text: str) -> None:
        self.warnings.append(f"{who}: {text}")


def skill_changes(before: Dict[str, str], after: Dict[str, str]):
    created = sorted(k for k in after if k not in before)
    removed = sorted(k for k in before if k not in after)
    touched = sorted(k for k in after if k in before and before[k] != after[k])
    return created, removed, touched


def _entries_for(entries, skill, kinds=None, exclude=None):
    return [e for e in entries if e["bundle"] == BUNDLE and skill in e["skills"]
            and (kinds is None or e["kind"] in kinds)
            and (exclude is None or e["kind"] not in exclude)]


def check_remove(rep, added, skill):
    who = f"{BUNDLE}/{skill}"
    if not _entries_for(added, skill, kinds={"remove"}):
        rep.fail(who, f"SKILL.md was removed with no new `remove` entry in {IMPACT_FILE}",
                 f"{IMPACT_FILE} records every removal, with its motivation",
                 f"Add `## <date> — {who} — remove` with Motivation, Change, Eval and Outcome lines")


def check_create(rep, added, skill):
    who = f"{BUNDLE}/{skill}"
    entries = _entries_for(added, skill, kinds={"create"})
    if not entries:
        rep.fail(who, f"a new skill has no new `create` entry in {IMPACT_FILE}",
                 f"{IMPACT_FILE} records every creation, with its eval result",
                 f"Add `## <date> — {who} — create` with an Eval line carrying the "
                 "with_skill and without_skill counts and the routine run id")
        return
    if any(is_green(e["eval"]) for e in entries):
        return
    rep.fail(who, "the `create` entry's Eval line does not show a green with_skill arm",
             "docs/skill-impact.md's graduation gate requires a green `with_skill` arm before a skill graduates",
             "Run the skill's fixtures through the skills-evals eval routine and write "
             "`with_skill objective X/Y, without_skill A/B` (X > 0, X/Y >= A/B) with the run id "
             "or results link on the Eval line")


def check_touch(rep, added, skill, census, census_why):
    who = f"{BUNDLE}/{skill}"
    entries = _entries_for(added, skill, exclude={"rejected"})
    if not entries:
        rep.fail(who, f"SKILL.md changed with no new entry in {IMPACT_FILE} naming this skill",
                 f"{IMPACT_FILE} says every skill-content change appends an entry, in the same PR",
                 f"Add `## <date> — {who} — edit` with Motivation, Change, Eval and Outcome "
                 "lines (an entry covering several skills names each: `a, b`)")
        return
    texts = [e["eval"] for e in entries]
    ran = any(is_ran(t) for t in texts)
    exempt = any(is_exempt(t) for t in texts)
    first = any(is_first_fixture(t, skill) for t in texts)
    status = census_status(census, skill)
    run_fix = ("run the skill's eval through the skills-evals eval routine and put its "
               "counts (e.g. 21/21) or run id on the Eval line")
    if status == "covered":
        if not ran:
            rep.fail(who, "the Eval line shows no eval run, and the census lists the skill as covered",
                     "docs/skill-impact.md's touch gate requires a covered skill's eval to run on every SKILL.md edit",
                     run_fix[0].upper() + run_fix[1:])
    elif status == "skipped":
        if not (ran or exempt):
            rep.fail(who, "the Eval line shows neither an eval run nor `exempt`, and the census "
                     "lists the skill as deliberately not covered",
                     "docs/skill-impact.md accepts `exempt` for a skill in the non-coverage table, but the entry must say so",
                     "Write `exempt (DESIGN.md non-coverage table)` on the Eval line, or " + run_fix)
    elif status == "gap":
        if not (ran or first):
            rep.fail(who, "the Eval line shows neither an eval run nor a first fixture, and the "
                     "census lists the skill as having no fixture",
                     "docs/skill-impact.md's touch gate requires either a run or the skill's first fixture",
                     "Link the skills-evals pull request adding `evals/" + skill + "/` on the Eval "
                     "line, or " + run_fix)
    elif not (ran or exempt or first):
        if census_why is not None:
            reason = f"the census could not be read ({census_why})"
        elif status is None:
            reason = "the census does not list this skill"
        else:
            reason = f"the census status `{status}` is not one this check knows"
        rep.warn(who, f"the Eval line shows no eval run, first fixture or exemption, and {reason}, "
                 "so the touch gate could not decide it; missing data never blocks")


def run(base: str, head: str, census_source: str) -> Tuple[int, List[str], Report]:
    out: List[str] = []
    point = merge_base(base, head)
    created, removed, touched = skill_changes(skill_blobs(point), skill_blobs(head))
    impact_changed = blob_id(point, IMPACT_FILE) != blob_id(head, IMPACT_FILE)
    rep = Report()

    base_entries, base_bad = parse_entries(show(point, IMPACT_FILE) or "")
    if impact_changed:
        head_entries, head_bad = parse_entries(show(head, IMPACT_FILE) or "")
    else:
        head_entries, head_bad = base_entries, base_bad
    added = new_entries(head_entries, base_entries)

    if impact_changed:
        for heading in append_only_violations(head_entries, base_entries):
            rep.failures.append(
                f"skill-gates: {IMPACT_FILE}: the entry \"{heading}\" present at the merge-base "
                "is missing or changed at head. The file is append-only, so the history of what "
                "was tried stays intact. Add a correcting entry instead of editing an old one")
        old_bad = {identity(b) for b in base_bad}
        for bad in head_bad:
            if identity(bad) not in old_bad:
                rep.failures.append(
                    f"skill-gates: {IMPACT_FILE}: the new heading \"{bad['heading']}\" {bad['why']}. "
                    "A malformed entry satisfies no gate. Write it as "
                    f"`## YYYY-MM-DD — {BUNDLE}/<skill> — <{'|'.join(KINDS)}>`")
        for e in added:
            if e["bundle"] != BUNDLE:
                rep.failures.append(
                    f"skill-gates: {IMPACT_FILE}: the new entry \"{e['heading']}\" names bundle "
                    f"`{e['bundle']}`. Every skill here is in the `{BUNDLE}` bundle, so it "
                    f"satisfies no gate. Write `{BUNDLE}/<skill>`")

    census, census_why = None, None
    if touched:
        if census_source != "none":
            census, census_why = load_census(census_source)
            if census is None:
                rep.warn("census", f"could not read the census at {census_source} ({census_why})")
        else:
            census_why = "--census none"

    for skill in removed:
        check_remove(rep, added, skill)
    for skill in created:
        check_create(rep, added, skill)
    for skill in touched:
        check_touch(rep, added, skill, census, census_why)

    if not (created or removed or touched):
        out.append("skill-gates: no skill created, edited or removed")
    else:
        out.append(f"skill-gates: merge-base {point[:12]}; checked {len(created)} created, "
                   f"{len(touched)} edited, {len(removed)} removed skill(s) "
                   f"against {len(added)} new impact entr{'y' if len(added) == 1 else 'ies'}")
    return (1 if rep.failures else 0), out, rep


def _annotation(text: str) -> str:
    esc = text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
    return f"::warning title=skill-gates::{esc}"


def _write_summary(head_line: str, failures: List[str], warnings: List[str],
                   warn_only: bool) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    mode = "warn-only" if warn_only else "enforcing"
    lines = [f"## Skill gates ({mode})", "", head_line, ""]
    if failures:
        label = "would fail once enforcing" if warn_only else "failures"
        lines += [f"**{len(failures)} {label}:**", ""] + [f"- {f.removeprefix('skill-gates: ')}" for f in failures] + [""]
    if warnings:
        lines += [f"**{len(warnings)} warning(s):**", ""] + [f"- {w}" for w in warnings] + [""]
    if not failures and not warnings:
        lines += ["No findings.", ""]
    rules = "Rules: the header of `docs/skill-impact.md`."
    try:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write("\n".join(lines + [rules, ""]))
    except OSError as exc:
        print(f"skill-gates: could not write the step summary ({type(exc).__name__})",
              file=sys.stderr)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--base", required=True)
    ap.add_argument("--head", required=True)
    ap.add_argument("--census", default=DEFAULT_CENSUS,
                    help="path or https URL of the coverage census, or `none`")
    ap.add_argument("--warn-only", action="store_true",
                    help="report failures and errors as warnings and always exit 0")
    args = ap.parse_args(argv)
    annotate = os.environ.get("GITHUB_ACTIONS") == "true"

    def warn(text: str) -> None:
        print(_annotation(text) if annotate else f"skill-gates (warning): {text}")

    try:
        code, lines, rep = run(args.base, args.head, args.census)
    except GateError as exc:
        error = f"the check could not run: {exc}"
    except Exception as exc:  # a crash; enforcing mode lets the traceback show
        if not args.warn_only:
            raise
        error = f"the check crashed: {type(exc).__name__}: {exc}"
    else:
        for line in lines:
            print(line)
        for w in rep.warnings:
            warn(w)
        if args.warn_only:
            for f in rep.failures:
                warn(f.removeprefix("skill-gates: "))
            if rep.failures:
                print(f"skill-gates: {len(rep.failures)} finding(s) that would fail once "
                      "enforcing; warn-only, so exit 0")
        else:
            for f in rep.failures:
                print(f)
            if rep.failures:
                print(f"skill-gates: {len(rep.failures)} failure(s)")
        _write_summary(lines[0], rep.failures, rep.warnings, args.warn_only)
        return 0 if args.warn_only else code

    # The check could not run.
    _write_summary(error, [], [], args.warn_only)
    if args.warn_only:
        warn(error)
        return 0
    print(f"skill-gates: error: {error}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
