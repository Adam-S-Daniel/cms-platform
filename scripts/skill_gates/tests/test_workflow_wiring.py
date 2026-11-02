"""How self-ci.yml runs the skill gates: in the REQUIRED python-unit-tests job,
on pull_request only, behind an in-job salience step.

Parses the workflow with PyYAML (no line scanning for structure) and runs the
salience step's own `run:` script under bash against throwaway git repos, so
a broken path filter fails here rather than silently skipping the gate.
Deterministic: local git only, no network.

Run: python3 -m pytest scripts/skill_gates -q
"""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
SELF_CI = REPO_ROOT / ".github" / "workflows" / "self-ci.yml"
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


def test_trigger_is_unfiltered_and_has_no_concurrency(workflow):
    """A required context must always report: no paths filter, no group."""
    on = workflow[True]  # PyYAML reads the bare `on` key as True
    for event in ("pull_request", "push"):
        block = on.get(event) or {}
        assert "paths" not in block and "paths-ignore" not in block, event
    assert "concurrency" not in workflow
    assert "concurrency" not in workflow["jobs"][JOB]
    assert "if" not in workflow["jobs"][JOB]


def test_checkout_fetches_full_history(steps):
    checkout = next(s for s in steps if str(s.get("uses", "")).startswith("actions/checkout@"))
    assert (checkout.get("with") or {}).get("fetch-depth") == 0


def test_pytest_step_runs_this_suite(steps):
    step = _step(steps, runs="python3 -m pytest")
    assert "scripts/skill_gates" in step["run"].split()


def test_gate_runs_only_on_salient_pull_requests(steps):
    salience = _step(steps, step_id=SALIENCE_ID)
    gate = _step(steps, runs=GATE_SCRIPT)
    assert "github.event_name == 'pull_request'" in salience["if"]
    assert "github.event_name == 'pull_request'" in gate["if"]
    assert f"steps.{SALIENCE_ID}.outputs.salient == 'true'" in gate["if"]
    assert steps.index(salience) < steps.index(gate)


def test_scripts_read_shas_from_the_event_file(steps):
    for step in (_step(steps, step_id=SALIENCE_ID), _step(steps, runs=GATE_SCRIPT)):
        assert "${{" not in step["run"]
        assert "$GITHUB_EVENT_PATH" in step["run"]


# ---------------------------------------------------------------------------
# the salience script itself, run under bash
# ---------------------------------------------------------------------------

def _git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True,
                          capture_output=True, text=True).stdout.strip()


def _salient(steps, tmp_path, changed):
    if shutil.which("jq") is None:
        pytest.skip("jq is not installed (the GitHub-hosted runner has it)")
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "test@example.com")
    _git(repo, "config", "user.name", "Test")
    (repo / "skills" / "a").mkdir(parents=True)
    (repo / "skills" / "a" / "SKILL.md").write_text("v1\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    base = _git(repo, "rev-parse", "HEAD")
    for rel in changed:
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("changed\n", encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "--allow-empty", "-m", "pr")
    head = _git(repo, "rev-parse", "HEAD")
    event = tmp_path / "event.json"
    event.write_text(json.dumps({"pull_request": {"base": {"sha": base}, "head": {"sha": head}}}),
                     encoding="utf-8")
    output = tmp_path / "output"
    output.write_text("", encoding="utf-8")
    env = dict(os.environ, GITHUB_EVENT_PATH=str(event), GITHUB_OUTPUT=str(output),
               RUNNER_TEMP=str(tmp_path))
    script = _step(steps, step_id=SALIENCE_ID)["run"]
    subprocess.run(["bash", "-c", script], cwd=repo, env=env, check=True,
                   capture_output=True, text=True)
    lines = output.read_text(encoding="utf-8").split()
    assert len(lines) == 1, lines
    return lines[0]


@pytest.mark.parametrize("changed,expected", [
    (["skills/a/SKILL.md"], "salient=true"),
    (["skills/new-skill/SKILL.md"], "salient=true"),
    (["docs/skill-impact.md"], "salient=true"),
    (["README.md", "skills/a/references/x.md"], "salient=true"),
    (["docs/CI-INVARIANTS.md", "scripts/x.js"], "salient=false"),
    ([], "salient=false"),
])
def test_salience_script(steps, tmp_path, changed, expected):
    assert _salient(steps, tmp_path, changed) == expected
