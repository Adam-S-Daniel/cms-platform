"""Tests for scripts/skill_gates/check_skill_gates.py.

Hermetic and deterministic: each scenario builds a throwaway git repo under
pytest's `tmp_path` with a repo-local identity, and the census is a JSON file
in tmp_path, never the network. Every gate scenario runs the script as a
subprocess, so the exit code asserted is the one CI reads.

The loop-format test at the bottom copies the impact entry skills-evals'
scripts/retire_skill.py writes, with invented values and this repository's
bundle name: a retirement pull request must pass this gate as written.

Run: python3 -m pytest scripts/skill_gates -q
"""

import json
import os
import subprocess
import sys
from pathlib import Path

GATES_DIR = Path(__file__).resolve().parent.parent
SCRIPT = GATES_DIR / "check_skill_gates.py"
REPO_ROOT = GATES_DIR.parent.parent

sys.path.insert(0, str(GATES_DIR))
import check_skill_gates as csg  # noqa: E402

_GIT_VERBATIM = ("-c", "core.autocrlf=false", "-c", "core.eol=lf")

HEADER = """# skill-impact.md — fixture

## Entry format

```
## YYYY-MM-DD — <bundle>/<skill> — <create|edit|rename|remove|rejected>
- Motivation: one line
- Eval: 21/21
```

Rules:

- Append-only.

---
"""

BUNDLE = "cms-platform"
SKILL = "widget-polisher"
OTHER = "gadget-sorter"

OLD_ENTRY = f"""## 2026-01-01 — {BUNDLE}/{SKILL} — create

- Motivation: invented.
- Change: new skill.
- Eval: routine run `20260101T000000Z-aaaaaa`, with_skill objective 3/3, without_skill 1/3.
- Outcome: merged 2026-01-02.
"""

OTHER_OLD = f"""## 2026-01-01 — {BUNDLE}/{OTHER} — create

- Motivation: invented.
- Change: new skill.
- Eval: routine run `20260101T000000Z-bbbbbb`, with_skill objective 2/2, without_skill 0/2.
- Outcome: merged 2026-01-02.
"""


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *_GIT_VERBATIM, "-C", str(repo), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")


def skill_dir(repo: Path, skill: str) -> Path:
    return repo / "skills" / skill


def impact(repo: Path, *entries: str) -> None:
    _write(repo / "docs" / "skill-impact.md", HEADER + "\n" + "\n---\n\n".join(entries))


def commit(repo: Path, msg: str = "c") -> str:
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--allow-empty", "-m", msg)
    return _git(repo, "rev-parse", "HEAD")


def make_repo(tmp_path: Path) -> Path:
    """main with two shipped skills and their create entries, plus
    skills/README.md; a `pr` branch checked out from it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    _write(repo / "skills" / "README.md", "# Skills\n")
    for skill in (SKILL, OTHER):
        _write(skill_dir(repo, skill) / "SKILL.md", f"# {skill}\n\nv1\n")
    impact(repo, OLD_ENTRY, OTHER_OLD)
    commit(repo, "base")
    _git(repo, "checkout", "-q", "-b", "pr")
    return repo


def census_file(tmp_path: Path, status: str, skill: str = SKILL) -> Path:
    """The census shape skills-evals publishes: cms-platform rows carry
    `bundle: null`."""
    path = tmp_path / "census.json"
    path.write_text(json.dumps({"schema": 1, "registries": [
        {"name": "adam-agentskills", "skills": [
            {"skill": skill, "bundle": "adam-coding-anywhere", "status": "covered"}]},
        {"name": "cms-platform", "skills": [
            {"skill": skill, "bundle": None, "registry": "cms-platform",
             "status": status, "fixtures": 1, "reason": None}]}]}),
        encoding="utf-8")
    return path


def gate(repo: Path, census="none", base="main", head="pr", env=None, extra=()):
    full_env = {k: v for k, v in os.environ.items()
                if k not in ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY")}
    full_env.update(env or {})
    proc = subprocess.run(
        [sys.executable, str(SCRIPT), "--base", base, "--head", head, "--census", str(census),
         *extra],
        cwd=repo, capture_output=True, text=True, env=full_env)
    return proc.returncode, proc.stdout + proc.stderr


def edit_skill(repo: Path, skill: str = SKILL) -> None:
    _write(skill_dir(repo, skill) / "SKILL.md", f"# {skill}\n\nv2\n")


def entry(kind: str, eval_text: str, skill: str = SKILL, bundle: str = BUNDLE,
          date: str = "2026-10-30") -> str:
    return (f"## {date} — {bundle}/{skill} — {kind}\n\n- Motivation: invented.\n"
            f"- Change: invented.\n- Eval: {eval_text}\n- Outcome: pending\n")


def touch(repo: Path, eval_text: str, kind: str = "edit", skill_for_entry: str = SKILL) -> None:
    edit_skill(repo)
    impact(repo, entry(kind, eval_text, skill=skill_for_entry), OLD_ENTRY, OTHER_OLD)
    commit(repo)


# ---------------------------------------------------------------------------
# basics
# ---------------------------------------------------------------------------

def test_no_skill_change_passes(tmp_path):
    repo = make_repo(tmp_path)
    _write(repo / "README.md", "hi\n")
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out
    assert "no skill created, edited or removed" in out


def test_non_skill_files_under_skills_are_not_a_touch(tmp_path):
    repo = make_repo(tmp_path)
    _write(skill_dir(repo, SKILL) / "references" / "x.md", "x\n")
    _write(repo / "skills" / "README.md", "# Skills, edited\n")
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out
    assert "no skill created, edited or removed" in out


def test_unresolvable_merge_base_exits_2(tmp_path):
    repo = make_repo(tmp_path)
    code, out = gate(repo, base="0" * 40)
    assert code == 2, out
    assert "merge-base" in out


# ---------------------------------------------------------------------------
# touch gate
# ---------------------------------------------------------------------------

def test_touch_without_entry_fails(tmp_path):
    repo = make_repo(tmp_path)
    edit_skill(repo)
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out
    assert f"skill-gates: {BUNDLE}/{SKILL}: SKILL.md changed with no new entry" in out


def test_covered_touch_not_run_fails(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run; wording only")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out
    assert "census lists the skill as covered" in out


def test_covered_touch_outstanding_fails(tmp_path):
    """The wording this repository's impact log used for an eval not run."""
    repo = make_repo(tmp_path)
    touch(repo, "outstanding — the skills-evals fixture (3/3 last time) was not run")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out


def test_covered_touch_with_counts_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "exit 0, 21/21 objective checks")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 0, out


def test_covered_touch_with_run_id_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "routine run `20261030T101010Z-0a1b2c`, no regression")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 0, out


def test_covered_touch_counts_but_starting_none_fails(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "`none` — the old 3/3 run predates this edit")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out


NEGATED = ("not yet run (target 8/8)", "skipped, previous 21/21", "not exempt; outstanding",
           "did not run; routine run `20261030T101010Z-0a1b2c` predates this edit",
           "nothing run yet, 3/3 planned")


def test_negated_eval_lines_show_no_run():
    for text in NEGATED:
        assert csg.is_negated(text), text
        assert not csg.is_ran(text), text
        assert not csg.is_exempt(text), text
    # Words that only look like negations do not void a run.
    for text in ("exit 0, 21/21, no regression", "3/3; no runner errors",
                 "routine run `20261026T211234Z-1b7681`, 6/7; judge skipped"):
        assert csg.is_ran(text), text


def test_negated_touch_of_a_covered_skill_fails(tmp_path):
    for n, text in enumerate(NEGATED):
        root = tmp_path / f"case{n}"
        root.mkdir()
        repo = make_repo(root)
        touch(repo, text)
        code, out = gate(repo, census_file(root, "covered"))
        assert code == 1, (text, out)
        assert "census lists the skill as covered" in out, out


def test_not_exempt_touch_of_a_skipped_skill_fails(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not exempt; outstanding")
    code, out = gate(repo, census_file(tmp_path, "skipped"))
    assert code == 1, out


def test_gap_touch_not_run_with_first_fixture_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run; first fixture in https://github.com/Adam-S-Daniel/skills-evals/pull/9")
    code, out = gate(repo, census_file(tmp_path, "gap"))
    assert code == 0, out


def test_skipped_touch_exempt_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "exempt (DESIGN.md non-coverage table)")
    code, out = gate(repo, census_file(tmp_path, "skipped"))
    assert code == 0, out


def test_skipped_touch_without_evidence_fails(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run")
    code, out = gate(repo, census_file(tmp_path, "skipped"))
    assert code == 1, out
    assert "exempt" in out


def test_gap_touch_with_first_fixture_pr_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "first fixture in [skills-evals#9](https://github.com/Adam-S-Daniel/skills-evals/pull/9)")
    code, out = gate(repo, census_file(tmp_path, "gap"))
    assert code == 0, out


def test_gap_touch_with_exempt_only_fails(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "exempt")
    code, out = gate(repo, census_file(tmp_path, "gap"))
    assert code == 1, out
    assert "first fixture" in out


def test_unreadable_census_warns_and_passes(tmp_path):
    for name, content in (("missing.json", None), ("bad.json", "{not json"),
                          ("schema.json", json.dumps({"schema": 2, "registries": []})),
                          ("noreg.json", json.dumps({"schema": 1, "registries": [
                              {"name": "adam-agentskills", "skills": []}]}))):
        repo_root = tmp_path / name
        repo_root.mkdir()
        repo = make_repo(repo_root)
        touch(repo, "not run; wording only")
        path = repo_root / name
        if content is not None:
            path.write_text(content, encoding="utf-8")
        code, out = gate(repo, path)
        assert code == 0, (name, out)
        assert "skill-gates (warning): census: could not read the census" in out, out
        assert "missing data never blocks" in out, out


def test_census_none_warns_and_passes(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run")
    code, out = gate(repo, "none")
    assert code == 0, out
    assert "--census none" in out


def test_skill_absent_from_census_warns(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run")
    code, out = gate(repo, census_file(tmp_path, "covered", skill="someone-else"))
    assert code == 0, out
    assert "does not list this skill" in out


def test_census_reads_the_cms_platform_registry_not_another(tmp_path):
    """census_file lists the skill as `covered` under adam-agentskills too;
    only the cms-platform row (`skipped`) may decide."""
    repo = make_repo(tmp_path)
    touch(repo, "exempt (DESIGN.md non-coverage table)")
    code, out = gate(repo, census_file(tmp_path, "skipped"))
    assert code == 0, out


def test_warning_is_an_annotation_under_actions(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run")
    code, out = gate(repo, env={"GITHUB_ACTIONS": "true"})
    assert code == 0, out
    assert "::warning title=skill-gates::" in out


def test_entry_for_a_different_skill_does_not_satisfy(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "21/21", skill_for_entry=OTHER)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out
    assert f"{BUNDLE}/{SKILL}: SKILL.md changed with no new entry" in out


def test_multi_skill_entry_covers_each_named_skill(tmp_path):
    repo = make_repo(tmp_path)
    edit_skill(repo)
    edit_skill(repo, OTHER)
    impact(repo, entry("edit", "21/21 and 8/8", skill=f"{SKILL}, {OTHER}"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 0, out


def test_aggregate_entry_names_no_skill(tmp_path):
    repo = make_repo(tmp_path)
    edit_skill(repo)
    impact(repo, entry("edit", "21/21", skill="(2 skills)"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out
    assert "no new entry in docs/skill-impact.md naming this skill" in out


def test_rejected_entry_does_not_satisfy_a_touch(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "21/21", kind="rejected")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out


def test_an_old_entry_does_not_satisfy_a_new_touch(tmp_path):
    repo = make_repo(tmp_path)
    edit_skill(repo)  # OLD_ENTRY (a create with counts) is already at the merge-base
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out


def test_fenced_entry_example_is_not_an_entry(tmp_path):
    repo = make_repo(tmp_path)
    edit_skill(repo)
    fenced = f"```\n## 2026-10-30 — {BUNDLE}/{SKILL} — edit\n- Eval: 21/21\n```\n"
    impact(repo, fenced, OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 1, out
    assert "no new entry" in out
    assert csg.parse_entries(HEADER + fenced) == ([], [])


def test_wrapped_eval_bullet_is_one_text():
    src = HEADER + (f"\n## 2026-10-30 — {BUNDLE}/{SKILL} — edit\n\n- Motivation: x\n"
                    "- Eval: the routine scored\n  21/21 on train\n- Outcome: y\n")
    [e], bad = csg.parse_entries(src)
    assert bad == []
    assert e["eval"] == "the routine scored\n21/21 on train"
    assert e["kind"] == "edit"
    assert e["skills"] == [SKILL]


def test_sibling_edit_on_main_is_not_attributed_to_the_pr(tmp_path):
    repo = make_repo(tmp_path)
    _write(repo / "notes.txt", "pr work\n")
    commit(repo, "pr")
    # main advances with its own (ungated) skill edit after the fork.
    _git(repo, "checkout", "-q", "main")
    edit_skill(repo, skill=OTHER)
    commit(repo, "main sibling")
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 0, out
    assert "no skill created, edited or removed" in out


# ---------------------------------------------------------------------------
# malformed new headings
# ---------------------------------------------------------------------------

def test_new_malformed_dated_heading_fails(tmp_path):
    repo = make_repo(tmp_path)
    bad = "## 2026-10-30 — widget-polisher edited\n\n- Eval: 21/21\n"
    impact(repo, bad, OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert 'the new heading "2026-10-30 — widget-polisher edited"' in out


def test_new_entry_with_unknown_kind_fails(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, entry("tweak", "21/21"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert "has kind `tweak`" in out


def test_new_entry_for_another_bundle_fails(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, entry("edit", "21/21", bundle="adam-coding-anywhere"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert "names bundle `adam-coding-anywhere`" in out


def test_an_old_malformed_heading_never_blocks(tmp_path):
    repo = make_repo(tmp_path)
    bad = "## 2026-01-01 — legacy note\n\n- Eval: n/a\n"
    impact(repo, bad, OLD_ENTRY, OTHER_OLD)
    commit(repo)
    _git(repo, "branch", "-f", "main", "HEAD")
    touch_entries = (entry("edit", "21/21"), bad, OLD_ENTRY, OTHER_OLD)
    edit_skill(repo)
    impact(repo, *touch_entries)
    commit(repo)
    code, out = gate(repo, census_file(tmp_path, "covered"))
    assert code == 0, out


# ---------------------------------------------------------------------------
# graduation gate
# ---------------------------------------------------------------------------

DRAFT_EVAL = ("draft-loop measurement, skills-evals routine run `20261031T120000Z-abc123`, "
              "3 trials per arm over 2 new fixtures: with_skill objective 14/18, without_skill "
              "9/18. Not badge input; the fixtures land in a companion skills-evals PR.")
ROUTINE_EVAL = ("routine run `20261026T211234Z-1b7681`, 3 trials per arm, subscription billing. "
                "`with_skill` objective 6/7 every trial, `without_skill` 5/7; judge skipped.")


def create(repo: Path, eval_text: str, skill: str = "new-gizmo") -> None:
    _write(skill_dir(repo, skill) / "SKILL.md", "# new\n")
    impact(repo, entry("create", eval_text, skill=skill), OLD_ENTRY, OTHER_OLD)
    commit(repo)


def test_create_green_passes_draft_format(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, DRAFT_EVAL)
    code, out = gate(repo)
    assert code == 0, out


def test_create_green_passes_routine_format(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, ROUTINE_EVAL)
    code, out = gate(repo)
    assert code == 0, out


def test_create_green_with_results_link_passes(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "with_skill objective 9/9, without_skill 1/9 "
                 "(https://github.com/Adam-S-Daniel/skills-evals/tree/persistent/eval-results/x)")
    code, out = gate(repo)
    assert code == 0, out


def test_create_without_green_eval_fails(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "not run yet")
    code, out = gate(repo)
    assert code == 1, out
    assert "green with_skill arm" in out


def test_create_with_skill_below_without_fails(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "routine run `20261031T120000Z-abc123`: with_skill objective 5/9, without_skill 6/9")
    code, out = gate(repo)
    assert code == 1, out
    assert "green with_skill arm" in out


def test_create_with_skill_zero_fails(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "routine run `20261031T120000Z-abc123`: with_skill objective 0/9, without_skill 0/9")
    code, out = gate(repo)
    assert code == 1, out


def test_create_green_without_run_id_fails(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "with_skill objective 9/9, without_skill 1/9")
    code, out = gate(repo)
    assert code == 1, out


def test_create_negated_green_fails(tmp_path):
    repo = make_repo(tmp_path)
    create(repo, "not yet run (target with_skill objective 8/8, without_skill 1/8, "
                 "routine run `20261031T120000Z-abc123`)")
    code, out = gate(repo)
    assert code == 1, out
    assert "green with_skill arm" in out


def test_create_exempt_fails(tmp_path):
    """No machine-bound bundle here: `exempt` never graduates a skill."""
    repo = make_repo(tmp_path)
    create(repo, "exempt — no fixture yet")
    code, out = gate(repo)
    assert code == 1, out


def test_create_without_entry_fails(tmp_path):
    repo = make_repo(tmp_path)
    _write(skill_dir(repo, "new-gizmo") / "SKILL.md", "# new\n")
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert "no new `create` entry" in out


# ---------------------------------------------------------------------------
# removal, renames, append-only
# ---------------------------------------------------------------------------

def remove_skill(repo: Path, skill: str = SKILL) -> None:
    for f in skill_dir(repo, skill).iterdir():
        f.unlink()


def test_remove_with_entry_passes(tmp_path):
    repo = make_repo(tmp_path)
    remove_skill(repo)
    impact(repo, entry("remove", "n=12 pooled arm runs"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out


def test_remove_without_entry_fails(tmp_path):
    repo = make_repo(tmp_path)
    remove_skill(repo)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert "no new `remove` entry" in out


def test_renamed_skill_dir_is_a_create_and_a_remove(tmp_path):
    repo = make_repo(tmp_path)
    _write(skill_dir(repo, "widget-buffer") / "SKILL.md",
           (skill_dir(repo, SKILL) / "SKILL.md").read_text(encoding="utf-8"))
    remove_skill(repo)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert f"{BUNDLE}/widget-buffer: a new skill has no new `create` entry" in out
    assert f"{BUNDLE}/{SKILL}: SKILL.md was removed" in out


def test_rename_with_create_and_remove_entries_passes(tmp_path):
    """docs/skill-impact.md: a rename is a `create` entry for the new name
    (with its graduation arm) plus a `remove` entry for the old one."""
    repo = make_repo(tmp_path)
    _write(skill_dir(repo, "widget-buffer") / "SKILL.md",
           (skill_dir(repo, SKILL) / "SKILL.md").read_text(encoding="utf-8"))
    remove_skill(repo)
    impact(repo, entry("create", ROUTINE_EVAL, skill="widget-buffer"),
           entry("remove", "renamed to widget-buffer"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out


def test_rename_arrow_heading_is_reported_with_the_create_remove_rule(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, entry("rename", "none", skill=f"{SKILL} → widget-buffer"), OLD_ENTRY, OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert "a rename is a `create` entry for the new name plus a `remove` entry" in out


def test_rewording_an_old_entry_fails(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, OLD_ENTRY.replace("with_skill objective 3/3", "with_skill objective 2/3"),
           OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out
    assert f'"2026-01-01 — {BUNDLE}/{SKILL} — create"' in out
    assert "add a correcting entry instead of editing an old one" in out.lower()


def test_deleting_an_old_entry_fails(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, OLD_ENTRY)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out


def test_reordering_entries_passes(tmp_path):
    repo = make_repo(tmp_path)
    impact(repo, OTHER_OLD, OLD_ENTRY)
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out


# ---------------------------------------------------------------------------
# this repository's own impact log
# ---------------------------------------------------------------------------

def test_the_repository_impact_log_parses_with_zero_errors():
    """Every dated h2 in the committed docs/skill-impact.md is a well-formed
    entry for this bundle, including the multi-skill (`a, b`) and aggregate
    (`(13 skills)`) headings, and the fenced example is not one."""
    path = REPO_ROOT / "docs" / "skill-impact.md"
    src = path.read_text(encoding="utf-8")
    entries, malformed = csg.parse_entries(src)
    assert malformed == []
    dated_h2 = [ln for ln in src.split("\n") if ln.startswith("## 20")]
    assert len(entries) == len(dated_h2) > 0
    assert all(e["bundle"] == BUNDLE for e in entries)
    assert all(e["eval"] for e in entries), [e["heading"] for e in entries if not e["eval"]]
    assert not any(e["heading"].startswith("YYYY") for e in entries)


# ---------------------------------------------------------------------------
# the evals loop's retirement format (copied from skills-evals, invented values)
# ---------------------------------------------------------------------------

def retire_entry(bundle, skill):
    """skills-evals scripts/retire_skill.py impact_entry()."""
    return (f"## 2026-10-31 — {bundle}/{skill} — remove\n\n"
            "- Motivation: the retirement verdict is `retire` "
            "([skills-evals#70](https://github.com/Adam-S-Daniel/skills-evals/issues/70)): every cell "
            "(1 fixture(s) x 2 roster model(s)) "
            "shows no benefit at the retire confidence level.\n"
            f"- Change: `skills/{skill}/` removed, the skill dropped from "
            f"the README table, bundle `{bundle}` 1.0.0 -> "
            "2.0.0 (a removal is a breaking change), by skills-evals' "
            "`scripts/retire_skill.py` (workflow run https://example.com/run/1).\n"
            f"- Eval: n=24 pooled arm runs (with vs without the skill) as of "
            f"20261031T000000Z, fixtures evals/{skill}/alpha, "
            "policy evals/gate-policy.yml; per-cell bounds in the pull request.\n"
            "- Outcome: pending merge; auto-merges once required checks pass, with no "
            "human review ([ADR 0021](https://example.com/adr)).\n")


def insert_like_the_loop(repo: Path, new: str) -> None:
    """The loop inserts newest first, right after the header's `---` rule."""
    path = repo / "docs" / "skill-impact.md"
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    rule = lines.index("---")
    head = "\n".join(lines[:rule + 1]).rstrip("\n")
    rest = "\n".join(lines[rule + 1:]).lstrip("\n")
    _write(path, f"{head}\n\n{new}\n{rest}")


def test_outcome_update_in_place_fails(tmp_path):
    """Updating an old entry's Outcome (pending -> merged) is an edit too."""
    repo = make_repo(tmp_path)
    impact(repo, OLD_ENTRY.replace("merged 2026-01-02", "merged 2026-01-03"), OTHER_OLD)
    commit(repo)
    code, out = gate(repo)
    assert code == 1, out


# ---------------------------------------------------------------------------
# warn-only mode and the step summary
# ---------------------------------------------------------------------------

def test_warn_only_reports_failures_as_warnings_and_exits_0(tmp_path):
    repo = make_repo(tmp_path)
    touch(repo, "not run; wording only")
    census = census_file(tmp_path, "covered")
    code, out = gate(repo, census)
    assert code == 1, out  # enforcing: the same change fails
    code, out = gate(repo, census, extra=("--warn-only",))
    assert code == 0, out
    assert "skill-gates (warning): cms-platform/widget-polisher: the Eval line shows no eval run" in out
    assert "1 finding(s) that would fail once enforcing" in out


def test_warn_only_annotates_failures_under_actions(tmp_path):
    repo = make_repo(tmp_path)
    remove_skill(repo)
    commit(repo)
    code, out = gate(repo, env={"GITHUB_ACTIONS": "true"}, extra=("--warn-only",))
    assert code == 0, out
    assert "::warning title=skill-gates::cms-platform/widget-polisher: SKILL.md was removed" in out


def test_warn_only_turns_a_check_that_cannot_run_into_a_warning(tmp_path):
    repo = make_repo(tmp_path)
    code, out = gate(repo, base="0" * 40)
    assert code == 2, out
    code, out = gate(repo, base="0" * 40, extra=("--warn-only",))
    assert code == 0, out
    assert "skill-gates (warning): the check could not run" in out
    assert "merge-base" in out


def test_warn_only_outside_a_git_repo_exits_0(tmp_path):
    code, out = gate(tmp_path, base="HEAD^1", head="HEAD", extra=("--warn-only",))
    assert code == 0, out
    assert "could not run" in out


def test_step_summary_is_written_in_both_modes(tmp_path):
    repo = make_repo(tmp_path)
    remove_skill(repo)
    commit(repo)
    for mode, extra, label in (("warn", ("--warn-only",), "would fail once enforcing"),
                               ("enforce", (), "failures")):
        summary = tmp_path / f"summary-{mode}.md"
        gate(repo, env={"GITHUB_STEP_SUMMARY": str(summary)}, extra=extra)
        text = summary.read_text(encoding="utf-8")
        assert text.startswith("## Skill gates ("), text
        assert f"**1 {label}:**" in text, text
        assert "SKILL.md was removed" in text
        assert "the header of `docs/skill-impact.md`" in text


def test_step_summary_records_a_check_that_cannot_run(tmp_path):
    repo = make_repo(tmp_path)
    summary = tmp_path / "summary.md"
    code, _ = gate(repo, base="0" * 40, env={"GITHUB_STEP_SUMMARY": str(summary)},
                   extra=("--warn-only",))
    assert code == 0
    assert "the check could not run" in summary.read_text(encoding="utf-8")


def test_retire_loop_entry_passes(tmp_path):
    repo = make_repo(tmp_path)
    remove_skill(repo)
    insert_like_the_loop(repo, retire_entry(BUNDLE, SKILL))
    commit(repo)
    code, out = gate(repo)
    assert code == 0, out
