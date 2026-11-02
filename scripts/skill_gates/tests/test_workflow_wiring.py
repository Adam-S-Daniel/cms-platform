"""How self-ci.yml runs the skill gates: in the REQUIRED python-unit-tests job,
on pull_request only, behind an in-job salience step, WARN-ONLY.

Parses the workflow with PyYAML (no line scanning for structure), and runs
both steps' own `run:` scripts under bash the way GitHub does
(`bash --noprofile --norc -eo pipefail`) inside depth-2 clones of a real merge
commit, so a broken path filter, a checkout too shallow for the diff, or a
fail-safe that fails the job shows up here. Deterministic: local git only, no
network.

Run: python3 -m pytest scripts/skill_gates -q
"""

import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
SELF_CI = REPO_ROOT / ".github" / "workflows" / "self-ci.yml"
GATE_SRC = REPO_ROOT / "scripts" / "skill_gates" / "check_skill_gates.py"
JOB = "python-unit-tests"
SALIENCE_ID = "skill_gates_salient"
GATE_SCRIPT = "scripts/skill_gates/check_skill_gates.py"


@pytest.fixture(scope="module")
def workflow():
    return yaml.safe_load(SELF_CI.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def steps(workflow):
    return workflow["jobs"][JOB]["steps"]


def _step(steps, *, step_id=None, runs=None):
    found = [s for s in steps
             if (step_id is not None and s.get("id") == step_id)
             or (runs is not None and runs in (s.get("run") or ""))]
    assert len(found) == 1, f"expected one step ({step_id or runs}), found {len(found)}"
    return found[0]


def _commands(run: str):
    """Each shell command of a run script as an argv: continuations joined,
    one line at a time, split on `||`, `&&`, `|` and `;`, via shlex (never a
    regex). Enough for the flat scripts these steps run."""
    commands = []
    for line in run.replace("\\\n", " ").split("\n"):
        lexer = shlex.shlex(line, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        lexer.commenters = "#"
        current = []
        for token in lexer:
            if set(token) <= set(";&|"):
                if current:
                    commands.append(current)
                current = []
            else:
                current.append(token)
        if current:
            commands.append(current)
    return commands


# ---------------------------------------------------------------------------
# shape
# ---------------------------------------------------------------------------

def test_trigger_is_unfiltered_and_has_no_concurrency(workflow):
    """A required context must always report: no paths filter, no group."""
    on = workflow[True]  # PyYAML reads the bare `on` key as True
    for event in ("pull_request", "push"):
        block = on.get(event) or {}
        assert "paths" not in block and "paths-ignore" not in block, event
    assert "concurrency" not in workflow
    assert "concurrency" not in workflow["jobs"][JOB]
    assert "if" not in workflow["jobs"][JOB]


def test_checkout_is_depth_2(steps):
    """cms-platform#541: the merge commit and its parents, not full history."""
    checkout = [s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@")]
    assert len(checkout) == 1
    assert (checkout[0].get("with") or {}).get("fetch-depth") == 2


def test_pytest_step_runs_this_suite(steps):
    step = _step(steps, runs="python3 -m pytest")
    [argv] = [c for c in _commands(step["run"]) if c[:3] == ["python3", "-m", "pytest"]]
    assert "scripts/skill_gates" in argv


def test_gate_runs_only_on_salient_pull_requests(steps):
    salience = _step(steps, step_id=SALIENCE_ID)
    gate = _step(steps, runs=GATE_SCRIPT)
    assert "github.event_name == 'pull_request'" in salience["if"]
    assert "github.event_name == 'pull_request'" in gate["if"]
    assert f"steps.{SALIENCE_ID}.outputs.salient == 'true'" in gate["if"]
    assert steps.index(salience) < steps.index(gate)


def test_gate_is_warn_only_on_the_merge_commit(steps):
    gate = _step(steps, runs=GATE_SCRIPT)
    [argv] = [c for c in _commands(gate["run"]) if GATE_SCRIPT in c]
    assert argv[:2] == ["python3", GATE_SCRIPT]
    assert "--warn-only" in argv
    assert argv[argv.index("--base") + 1] == "HEAD^1"
    assert argv[argv.index("--head") + 1] == "HEAD"
    assert "continue-on-error" not in gate  # warn-only is the script's job, not the runner's


def test_scripts_interpolate_no_expressions(steps):
    for step in (_step(steps, step_id=SALIENCE_ID), _step(steps, runs=GATE_SCRIPT)):
        assert "${{" not in step["run"]


# ---------------------------------------------------------------------------
# behavior: both scripts run under bash in a depth-2 clone of a merge commit
# ---------------------------------------------------------------------------

def _git(repo, *args):
    return subprocess.run(["git", "-c", "core.quotepath=off", "-C", str(repo), *args],
                          check=True, capture_output=True, text=True).stdout.strip()


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _origin(tmp_path, change, merge=True):
    """A repo whose `target` branch is either the merge commit of a PR that
    applies `change(repo)` onto a main three commits deep (merge=True), or
    the PR head itself (merge=False, a single-parent HEAD)."""
    repo = tmp_path / "origin"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    _write(repo / "skills" / "a" / "SKILL.md", "v1\n")
    _write(repo / "docs" / "skill-impact.md", "# log\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    _git(repo, "checkout", "-q", "-b", "pr")
    change(repo)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--allow-empty", "-m", "pr")
    _git(repo, "checkout", "-q", "main")
    for n in range(3):  # main moves on after the fork
        _write(repo / "README.md", f"main {n}\n")
        _git(repo, "add", "-A")
        _git(repo, "commit", "-q", "-m", f"main {n}")
    if merge:
        _git(repo, "checkout", "-q", "-b", "target")
        _git(repo, "merge", "-q", "--no-ff", "-m", "merge", "pr")
    else:
        _git(repo, "branch", "target", "pr")
    return repo


def _clone(tmp_path, origin):
    """What actions/checkout's `fetch-depth: 2` leaves: HEAD plus its parents."""
    work = tmp_path / "work"
    subprocess.run(["git", "clone", "-q", "--depth", "2", "--branch", "target",
                    f"file://{origin}", str(work)], check=True, capture_output=True)
    return work


def _run_step(step, cwd, tmp_path, env=None):
    output = tmp_path / "github_output"
    output.write_text("", encoding="utf-8")
    script = tmp_path / "step.sh"
    script.write_text(step["run"], encoding="utf-8")
    full_env = {k: v for k, v in os.environ.items()
                if k not in ("GITHUB_ACTIONS", "GITHUB_STEP_SUMMARY")}
    full_env.update({"GITHUB_OUTPUT": str(output), "RUNNER_TEMP": str(tmp_path),
                     "GITHUB_ACTIONS": "true"}, **(env or {}))
    proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", str(script)],
                          cwd=cwd, env=full_env, capture_output=True, text=True)
    return proc, output.read_text(encoding="utf-8").split()


def _edit(rel):
    return lambda repo: _write(repo / rel, "changed\n")


def _move_skill_out(repo):
    _git(repo, "mv", "skills/a/SKILL.md", "archive-a.md")


@pytest.mark.parametrize("change,expected", [
    (_edit("skills/a/SKILL.md"), "salient=true"),
    (_edit("skills/new-skill/SKILL.md"), "salient=true"),
    (_edit("docs/skill-impact.md"), "salient=true"),
    (_edit("scripts/skill_gates/check_skill_gates.py"), "salient=true"),
    (_move_skill_out, "salient=true"),
    (_edit("skills/café/SKILL.md"), "salient=true"),
    (_edit("skills/new\nline/SKILL.md"), "salient=true"),
    # A NUL-delimited reader sees one path starting `notes/`; a line reader
    # would see `skills/b.md` and call it salient.
    (_edit("notes/a\nskills/b.md"), "salient=false"),
    (_edit("skills.md"), "salient=false"),
    (_edit("docs/CI-INVARIANTS.md"), "salient=false"),
    (_edit("scripts/x.js"), "salient=false"),
    (lambda repo: None, "salient=false"),
], ids=["edit", "create", "impact-log", "gate-itself", "moved-out", "non-ascii",
        "newline", "newline-not-salient", "prefix-trap", "docs", "script", "empty"])
def test_salience_step(steps, tmp_path, change, expected):
    work = _clone(tmp_path, _origin(tmp_path, change))
    proc, out = _run_step(_step(steps, step_id=SALIENCE_ID), work, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out == [expected], (out, proc.stdout)


def test_salience_fail_safe_on_a_non_merge_head(steps, tmp_path):
    work = _clone(tmp_path, _origin(tmp_path, _edit("README.md"), merge=False))
    proc, out = _run_step(_step(steps, step_id=SALIENCE_ID), work, tmp_path)
    assert proc.returncode == 0, proc.stderr
    assert out == ["salient=true"]
    assert "::warning title=skill-gates::" in proc.stdout


def test_salience_fail_safe_outside_a_repository(steps, tmp_path):
    bare = tmp_path / "not-a-repo"
    bare.mkdir()
    proc, out = _run_step(_step(steps, step_id=SALIENCE_ID), bare, tmp_path,
                          env={"GIT_CEILING_DIRECTORIES": str(tmp_path)})
    assert proc.returncode == 0, proc.stderr
    assert out == ["salient=true"]


def _with_gate_script(work):
    """The step runs the script by its repo path; place the real one there
    (untracked, so the commits the gate reads are unchanged)."""
    dest = work / GATE_SCRIPT
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(GATE_SRC, dest)


def _remove_skill_a(repo):
    _git(repo, "rm", "-q", "skills/a/SKILL.md")


def test_gate_step_warns_and_exits_0_on_a_failing_change(steps, tmp_path):
    work = _clone(tmp_path, _origin(tmp_path, _remove_skill_a))
    _with_gate_script(work)
    summary = tmp_path / "summary.md"
    proc, _ = _run_step(_step(steps, runs=GATE_SCRIPT), work, tmp_path,
                        env={"GITHUB_STEP_SUMMARY": str(summary)})
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "::warning title=skill-gates::cms-platform/a: SKILL.md was removed" in proc.stdout
    assert "1 finding(s) that would fail once enforcing" in proc.stdout
    assert "## Skill gates (warn-only)" in summary.read_text(encoding="utf-8")


def test_gate_step_reads_a_depth_2_clone_with_no_error(steps, tmp_path):
    """The merge base of HEAD^1 and HEAD is HEAD^1, so depth 2 is enough even
    though main moved on after the fork."""
    work = _clone(tmp_path, _origin(tmp_path, _edit("notes.txt")))
    _with_gate_script(work)
    proc, _ = _run_step(_step(steps, runs=GATE_SCRIPT), work, tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "skill-gates: no skill created, edited or removed" in proc.stdout
    assert "could not run" not in proc.stdout


def test_gate_step_fail_safe_on_a_non_merge_head(steps, tmp_path):
    work = _clone(tmp_path, _origin(tmp_path, _edit("README.md"), merge=False))
    # A depth-2 clone of a single-parent HEAD has HEAD^1 but not its parent:
    # cut it to depth 1 so HEAD^1 is unresolvable, as on a broken checkout.
    subprocess.run(["git", "-C", str(work), "fetch", "-q", "--depth", "1", "origin", "target"],
                   check=True, capture_output=True)
    _with_gate_script(work)
    proc, _ = _run_step(_step(steps, runs=GATE_SCRIPT), work, tmp_path)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "::warning title=skill-gates::the check could not run" in proc.stdout


def test_gate_step_survives_a_crashing_interpreter(steps, tmp_path):
    work = tmp_path / "work"
    work.mkdir()
    stub_dir = tmp_path / "bin"
    stub_dir.mkdir()
    stub = stub_dir / "python3"
    stub.write_text("#!/bin/sh\nexit 3\n", encoding="utf-8")
    stub.chmod(0o755)
    proc, _ = _run_step(_step(steps, runs=GATE_SCRIPT), work, tmp_path,
                        env={"PATH": f"{stub_dir}:{os.environ['PATH']}"})
    assert proc.returncode == 0, proc.stderr
    assert "::warning title=skill-gates::the skill gates exited 3" in proc.stdout
