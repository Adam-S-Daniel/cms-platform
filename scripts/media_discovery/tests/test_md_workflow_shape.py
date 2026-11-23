"""Shape tests for the media-discovery reusable and its thin caller.

Both files are parsed with yaml.safe_load, never scanned line by line. PyYAML
reads the bare key `on` as the boolean True (YAML 1.1), hence `data[True]`.
"""

import json
import re
import shlex
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
REUSABLE = REPO_ROOT / ".github" / "workflows" / "media-discovery.yml"
CALLER = REPO_ROOT / "examples" / "site" / ".github" / "workflows" / "media-discovery.yml"
MANIFEST = REPO_ROOT / "plugin.json"

FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
FORBIDDEN_IN_RUN = ("${{ inputs.", "${{ vars.", "${{ secrets.", "${{ github.event.")
CONFIGURED = "steps.detect.outputs.configured == 'true'"


def load(path: Path) -> dict:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(data, dict)
    return data


@pytest.fixture(scope="module")
def reusable():
    return load(REUSABLE)


@pytest.fixture(scope="module")
def caller():
    return load(CALLER)


def steps(data):
    [job] = data["jobs"].values()
    return job["steps"]


def step(data, step_id):
    [found] = [s for s in steps(data) if s.get("id") == step_id]
    return found


def shell_words(script: str) -> list[str]:
    return shlex.split(script.replace("\\\n", " "), comments=True)


def test_is_a_workflow_call_with_the_expected_interface(reusable):
    call = reusable[True]["workflow_call"]
    assert set(call) == {"inputs", "secrets"}
    assert call["inputs"] == {"platform_ref": {
        "description": call["inputs"]["platform_ref"]["description"],
        "type": "string", "required": True}}
    assert call["secrets"] == {name: {"required": False} for name in (
        "anthropic_api_key", "app_private_key", "smtp_user", "smtp_password", "mail_to", "mail_from")}


def test_permissions_are_contents_read_only(reusable):
    assert reusable["permissions"] == {"contents": "read"}
    [job] = reusable["jobs"].values()
    assert job.get("permissions", {"contents": "read"}) == {"contents": "read"}


def test_job_has_a_timeout_and_a_non_cancelling_group(reusable):
    [job] = reusable["jobs"].values()
    assert isinstance(job["timeout-minutes"], int) and 0 < job["timeout-minutes"] <= 60
    assert reusable["concurrency"]["cancel-in-progress"] is False
    assert "concurrency" not in job


def test_no_expression_is_interpolated_into_a_run_body(reusable):
    runs = [s["run"] for s in steps(reusable) if "run" in s]
    assert runs
    for run in runs:
        for needle in FORBIDDEN_IN_RUN:
            assert needle not in run, f"run: interpolates {needle}...: {run[:80]!r}"
        assert "${{" not in run, f"run: carries an expression: {run[:80]!r}"


def test_every_step_after_detect_is_gated_on_the_config(reusable):
    all_steps = steps(reusable)
    assert all_steps[0]["uses"].startswith("actions/checkout@")
    detect = all_steps[1]
    assert detect["id"] == "detect" and "if" not in detect
    assert ".github/media-discovery.yml" in detect["run"]
    assert "configured=true" in detect["run"] and "configured=false" in detect["run"]
    for later in all_steps[2:]:
        assert CONFIGURED in str(later.get("if", "")), f"ungated step: {later.get('name')}"


def test_the_app_token_is_minted_in_both_modes_with_narrow_permissions(reusable):
    mint = step(reusable, "app")
    # Gated on the App being configured, not on live mode: the results file is
    # written with this token in email-only runs too.
    assert "steps.mode.outputs.app == 'true'" in mint["if"]
    assert "outputs.mode" not in mint["if"]
    assert mint["env"] == {"APP_CLIENT_ID": "${{ vars.CMS_AUTOMATION_APP_ID }}",
                           "APP_PRIVATE_KEY": "${{ secrets.app_private_key }}",
                           "MODE": "${{ steps.mode.outputs.mode }}",
                           "RESULTS_REPO": "${{ vars.MEDIA_DISCOVERY_RESULTS_REPO }}"}
    script = mint["run"]
    words = shell_words(script)
    assert "mint-app-token.js" in words[words.index("node") + 1]
    # Permissions are chosen in the shell: pull_requests=write only in live mode.
    assert words[words.index("--permissions") + 1] == "$perms"
    assert 'perms="contents=write"' in script
    assert script.count("pull_requests=write") == 1
    assert 'if [ "$MODE" = "live" ]; then\n  perms="contents=write,pull_requests=write"' in \
        script.replace("            ", "")
    assert words[words.index("--repositories") + 1] == "$repos"
    # The results repository joins only when it is another repo of the same owner.
    assert '"${RESULTS_REPO%%/*}" = "$owner"' in script


def test_the_mode_step_reports_whether_the_app_is_configured(reusable):
    mode = step(reusable, "mode")
    assert 'echo "app=true"' in mode["run"] and 'echo "app=false"' in mode["run"]


def test_the_private_key_reaches_only_the_mode_and_mint_steps(reusable):
    users = [s.get("id") for s in steps(reusable)
             if "secrets.app_private_key" in json.dumps(s.get("env", {}))]
    assert users == ["mode", "app"]


def test_pr_writes_never_fall_back_to_github_token(reusable):
    run_step = steps(reusable)[-1]
    env = run_step["env"]
    assert env["APP_TOKEN"] == "${{ steps.app.outputs.token }}"
    assert env["READ_TOKEN"] == "${{ github.token }}"
    for s in steps(reusable):
        assert "GITHUB_TOKEN" not in s.get("env", {}) and "GH_TOKEN" not in s.get("env", {})
    script = run_step["run"]
    # The read token is exported only on the branch that also forces email-only.
    live_branch, _, rest = script.partition("else")
    assert 'export GITHUB_TOKEN="$APP_TOKEN"' in live_branch
    assert "MODE=email-only" in rest and 'export GITHUB_TOKEN="$READ_TOKEN"' in rest


def test_mode_comes_from_the_callers_variable(reusable):
    mode = step(reusable, "mode")
    assert mode["env"]["REQUESTED_MODE"] == "${{ vars.MEDIA_DISCOVERY_MODE }}"
    assert '"$REQUESTED_MODE" != "live"' in mode["run"]
    assert "CMS_AUTOMATION_APP_ID" in mode["run"]
    assert "CMS_AUTOMATION_APP_PRIVATE_KEY" in mode["run"]


def test_recipients_and_smtp_user_are_masked_before_the_cli_runs(reusable):
    script = steps(reusable)[-1]["run"]
    cli = script.index("python3 -m media_discovery run")
    assert script.index('::add-mask::$MEDIA_DISCOVERY_SMTP_USER') < cli
    assert script.index('::add-mask::$r') < cli
    assert "MEDIA_DISCOVERY_MAIL_TO" in script[:script.index('::add-mask::$r')]


def test_results_token_is_separate_from_github_token(reusable):
    run_step = steps(reusable)[-1]
    assert run_step["env"]["MEDIA_DISCOVERY_RESULTS_REPO"] == \
        "${{ vars.MEDIA_DISCOVERY_RESULTS_REPO }}"
    script = run_step["run"]
    handoff = 'export MEDIA_DISCOVERY_RESULTS_TOKEN="$APP_TOKEN"'
    assert handoff in script
    # Handed over in either mode, so before the live/email-only branch.
    assert script.index(handoff) < script.index('export GITHUB_TOKEN="$APP_TOKEN"')
    assert 'MEDIA_DISCOVERY_RESULTS_TOKEN="$READ_TOKEN"' not in script
    for s in steps(reusable):
        assert "MEDIA_DISCOVERY_RESULTS_TOKEN" not in s.get("env", {})


def test_cli_env_names_the_documented_knobs(reusable):
    env = steps(reusable)[-1]["env"]
    assert env["ANTHROPIC_API_KEY"] == "${{ secrets.anthropic_api_key }}"
    assert env["MEDIA_DISCOVERY_SMTP_USER"] == "${{ secrets.smtp_user }}"
    assert env["MEDIA_DISCOVERY_SMTP_PASSWORD"] == "${{ secrets.smtp_password }}"
    assert env["MEDIA_DISCOVERY_MAIL_TO"] == "${{ secrets.mail_to }}"
    assert env["MEDIA_DISCOVERY_MAIL_FROM"] == "${{ secrets.mail_from }}"
    assert env["MEDIA_DISCOVERY_REVIEWERS"] == "${{ vars.MEDIA_DISCOVERY_REVIEWERS }}"
    assert env["MEDIA_DISCOVERY_ADMIN_URL"] == "${{ steps.site.outputs.admin_url }}"


def test_platform_scripts_come_from_platform_ref_into_dot_cms_platform(reusable):
    [co] = [s for s in steps(reusable)
            if s.get("uses", "").startswith("actions/checkout@") and "with" in s
            and s["with"].get("path") == ".cms-platform"]
    assert co["with"]["ref"] == "${{ inputs.platform_ref }}"
    assert co["with"]["repository"] == "Adam-S-Daniel/cms-platform"
    assert "scripts/media_discovery" in co["with"]["sparse-checkout"]


def test_dependencies_are_installed_pinned(reusable):
    [install] = [s for s in steps(reusable) if "pip install" in s.get("run", "")]
    words = shell_words(install["run"])
    assert "anthropic==2.3.0" in words and "pyyaml==6.0.3" in words and "pypdf==6.21.4" in words
    assert "playwright==1.64.1" in words
    assert all("==" in w for w in words[words.index("--user") + 1:])


BROWSER_COMPOSITE = "./.cms-platform/.github/actions/install-playwright-browsers"


def test_chromium_is_installed_through_the_bounded_composite(reusable):
    # Owner choice A on #1002: the bounded composite, not a raw
    # `python3 -m playwright install --with-deps chromium`, which the
    # playwright-install-bounded lint forbids. The composite runs `npx playwright`
    # from .cms-platform/e2e, so Node and `npm ci` there must come first.
    all_steps = steps(reusable)
    assert not any("playwright install" in s.get("run", "") for s in all_steps)
    [pip] = [i for i, s in enumerate(all_steps) if "pip install" in s.get("run", "")]
    [node] = [i for i, s in enumerate(all_steps)
              if s.get("uses", "").startswith("actions/setup-node@")]
    [npm] = [i for i, s in enumerate(all_steps) if s.get("run", "").strip() == "npm ci"]
    [browser] = [i for i, s in enumerate(all_steps) if s.get("uses") == BROWSER_COMPOSITE]
    assert pip < browser and node < npm < browser
    assert all_steps[npm]["working-directory"] == ".cms-platform/e2e"
    assert all_steps[browser]["with"]["browser"] == "chromium"
    for i in (node, npm, browser):
        assert all_steps[i]["if"] == CONFIGURED


def test_the_sparse_checkout_carries_the_browser_installer(reusable):
    [co] = [s for s in steps(reusable)
            if s.get("uses", "").startswith("actions/checkout@") and "with" in s
            and s["with"].get("path") == ".cms-platform"]
    sparse = co["with"]["sparse-checkout"].split()
    for needed in (".github/actions/install-playwright-browsers",
                   "e2e/package.json", "e2e/package-lock.json"):
        assert needed in sparse


def test_third_party_actions_are_full_sha_pinned(reusable):
    for s in steps(reusable):
        if "uses" in s and not s["uses"].startswith("./"):
            ref = s["uses"].split("@", 1)[1]
            assert FULL_SHA.match(ref), s["uses"]


def test_caller_schedule_dispatch_and_permissions(caller):
    on = caller[True]
    assert on["schedule"] == [{"cron": "0 13 * * 1"}]
    assert "workflow_dispatch" in on and set(on) == {"schedule", "workflow_dispatch"}
    assert caller["permissions"] == {"contents": "read"}
    assert "run-name" in caller


def test_caller_pins_the_current_release_twice_alike(caller):
    version = "v" + json.loads(MANIFEST.read_text(encoding="utf-8"))["version"]
    [job] = caller["jobs"].values()
    assert job["uses"] == f"Adam-S-Daniel/cms-platform/.github/workflows/media-discovery.yml@{version}"
    assert job["with"] == {"platform_ref": version}


def test_caller_passes_exactly_the_documented_secrets(caller):
    [job] = caller["jobs"].values()
    assert job["secrets"] == {
        "anthropic_api_key": "${{ secrets.MEDIA_DISCOVERY_ANTHROPIC_API_KEY }}",
        "app_private_key": "${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}",
        "smtp_user": "${{ secrets.MEDIA_DISCOVERY_SMTP_USER }}",
        "smtp_password": "${{ secrets.MEDIA_DISCOVERY_SMTP_PASSWORD }}",
        "mail_to": "${{ secrets.MEDIA_DISCOVERY_MAIL_TO }}",
        "mail_from": "${{ secrets.MEDIA_DISCOVERY_MAIL_FROM }}",
    }
