"""Shape tests for the cross-post reusable + its thin-caller template.

These parse the real workflow YAML with `yaml.safe_load` (never a
regex/line-scanner — see AGENTS.md "Parse structured formats with a real
parser") and assert the structural contract that
`.github/workflows/cross-post.yml` (the reusable) and
`examples/site/.github/workflows/cross-post.yml` (the thin-caller template)
must hold: `workflow_call` inputs/secrets, minimal permissions, concurrency,
pinned third-party `uses:` refs, the platform-ref self-consistency of the
template's pin, no unsafe `${{ }}` interpolation into `run:` blocks, that
the Mastodon and LinkedIn tokens each only ever travel through one step's
`env:`, the schedule-only token-age check, and the per-leg `targets` gating.

This is the platform-side sibling of adamdaniel.ai's (now-retired)
`scripts/cross_post/tests/test_workflow_shape.py`, which asserted the SITE
workflow's shape before the module moved here (cms-platform#442).

PyYAML resolves the bare mapping key `on` to the boolean `True` (YAML 1.1
scalar resolution), not the string `"on"` — every lookup below uses
`data[True]` to account for that.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
CROSS_POST_REUSABLE = WORKFLOWS_DIR / "cross-post.yml"
TEMPLATE_DIR = REPO_ROOT / "examples" / "site" / ".github" / "workflows"
CROSS_POST_TEMPLATE = TEMPLATE_DIR / "cross-post.yml"
ROOT_MANIFEST = REPO_ROOT / "plugin.json"

FULL_SHA_RE = re.compile(r"^[0-9a-f]{40}$")
VERSION_TAG_RE = re.compile(r"^v\d+\.\d+\.\d+$")
CMS_PLATFORM_PREFIX = "Adam-S-Daniel/cms-platform/"
CMS_PLATFORM_ACTIONS_PREFIX = "Adam-S-Daniel/cms-platform/.github/actions/"


def _load_yaml(path: Path) -> dict[str, Any]:
    assert path.is_file(), f"missing workflow file: {path}"
    with path.open(encoding="utf-8") as fh:
        data = yaml.safe_load(fh)
    assert isinstance(data, dict)
    return data


def _raw_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _raw_lines(path: Path) -> list[str]:
    return _raw_text(path).splitlines()


def _canonical_version() -> str:
    doc = json.loads(ROOT_MANIFEST.read_text(encoding="utf-8"))
    version = str(doc.get("version", ""))
    assert version, f"{ROOT_MANIFEST} has no version"
    return f"v{version}"


def _uses_entries(lines: list[str]) -> list[tuple[str, str]]:
    """Return (raw_line, uses_value) for every `uses:` line in the file."""
    entries = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("uses:"):
            value = stripped[len("uses:") :].strip()
            entries.append((line, value))
    return entries


def _iter_steps(data: dict[str, Any]):
    for job in data["jobs"].values():
        for step in job.get("steps", []) or []:
            yield step


CONFIGURED_GUARD = "inputs.mastodon_instance != '' || inputs.substack || inputs.linkedin"


def _step_named(data: dict[str, Any], name: str) -> dict[str, Any]:
    matches = [s for s in _iter_steps(data) if s.get("name") == name]
    assert len(matches) == 1, f"expected exactly one step named {name!r}, found {len(matches)}"
    return matches[0]


def _steps_referencing(data: dict[str, Any], needle: str):
    """(step, in_run, in_with, in_env) for every step whose run/with/env mentions `needle`."""
    found = []
    for step in _iter_steps(data):
        in_run = needle in (step.get("run") or "")
        in_with = any(needle in str(v) for v in (step.get("with") or {}).values())
        in_env = any(needle in str(v) for v in (step.get("env") or {}).values())
        in_if = needle in str(step.get("if", ""))
        if in_run or in_with or in_env or in_if:
            found.append((step, in_run, in_with, in_env))
    return found


class TestCrossPostReusable:
    """`.github/workflows/cross-post.yml` — the platform reusable."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        self.data = _load_yaml(CROSS_POST_REUSABLE)
        self.lines = _raw_lines(CROSS_POST_REUSABLE)

    def test_is_a_workflow_call_reusable(self):
        on_block = self.data[True]
        assert "workflow_call" in on_block

    def test_prod_url_input_is_required_string(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        prod_url = inputs["prod_url"]
        assert prod_url["type"] == "string"
        assert prod_url["required"] is True

    def test_mastodon_instance_input_defaults_empty(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        mastodon_instance = inputs["mastodon_instance"]
        assert mastodon_instance["type"] == "string"
        assert mastodon_instance["default"] == ""

    def test_substack_input_is_boolean_default_false(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        substack = inputs["substack"]
        assert substack["type"] == "boolean"
        assert substack["default"] is False

    def test_post_path_input_defaults_empty_string(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        post_path = inputs["post_path"]
        assert post_path["type"] == "string"
        assert post_path["default"] == ""

    def test_dry_run_input_is_boolean_default_false(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        dry_run = inputs["dry_run"]
        assert dry_run["type"] == "boolean"
        assert dry_run["default"] is False

    def test_visibility_input_defaults_public(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        visibility = inputs["visibility"]
        assert visibility["type"] == "string"
        assert visibility["default"] == "public"

    def test_platform_repo_and_ref_inputs_have_platform_defaults(self):
        inputs = self.data[True]["workflow_call"]["inputs"]
        assert inputs["platform_repo"]["default"] == "Adam-S-Daniel/cms-platform"
        assert inputs["platform_ref"]["default"] == "main"

    def test_mastodon_access_token_secret_is_optional(self):
        secrets = self.data[True]["workflow_call"]["secrets"]
        assert secrets["MASTODON_ACCESS_TOKEN"]["required"] is False

    def test_permissions_are_contents_and_actions_read_only(self):
        # actions:read is required by the await-prod-deploy composite this
        # workflow calls (it queries the deploy-production run for this
        # commit); nothing else here needs write of any kind.
        assert self.data["permissions"] == {"contents": "read", "actions": "read"}

    def test_concurrency_group_and_no_cancel(self):
        concurrency = self.data["concurrency"]
        assert concurrency["group"] == "cross-post"
        assert concurrency["cancel-in-progress"] is False

    def test_third_party_uses_pinned_to_full_sha_no_trailing_comment(self):
        entries = _uses_entries(self.lines)
        assert entries, "expected at least one `uses:` step"
        for raw_line, value in entries:
            if value.startswith("./"):
                # A local composite path (the platform checked out into
                # .cms-platform/) crosses no repository boundary and carries
                # no @ref to pin at all.
                assert "@" not in value, f"local composite path should carry no @ref: {value}"
                continue
            assert "@" in value, f"uses line missing @ref: {value}"
            ref = value.rsplit("@", 1)[-1]
            assert FULL_SHA_RE.match(ref), f"uses ref is not a full 40-char sha: {value}"
            after_at = raw_line.split("@", 1)[-1]
            assert "#" not in after_at, f"trailing comment on uses line: {raw_line!r}"

    def test_never_references_a_remote_cms_platform_composite(self):
        # A consumer repo can enforce sha_pinning_required, which rejects a
        # composite action referenced by tag/SHA from ANOTHER repository
        # (GitHub: "all actions must be pinned to a full-length commit SHA"
        # even for a same-account cross-repo composite). await-prod-deploy
        # must therefore be invoked by the LOCAL path produced by the
        # "Checkout platform scripts" step, never
        # `Adam-S-Daniel/cms-platform/.github/actions/<name>@<ref>`.
        #
        # Scoped to actual `uses:` VALUES (not the raw file text) so this
        # cannot false-positive on a header comment explaining the rule in
        # prose — that prose necessarily quotes the very string this test
        # forbids as a real pin.
        entries = _uses_entries(self.lines)
        offenders = [v for _, v in entries if v.startswith(CMS_PLATFORM_ACTIONS_PREFIX)]
        assert offenders == [], (
            f"found a remote cms-platform composite reference(s) {offenders} — "
            "this must be a local ./.cms-platform/.github/actions/... path instead"
        )

    def test_await_prod_deploy_is_invoked_by_local_checked_out_path(self):
        entries = _uses_entries(self.lines)
        local_await = [v for _, v in entries if v == "./.cms-platform/.github/actions/await-prod-deploy"]
        assert local_await, "expected `uses: ./.cms-platform/.github/actions/await-prod-deploy`"

    def test_no_inline_expression_interpolation_in_run_blocks(self):
        for step in _iter_steps(self.data):
            run = step.get("run")
            if not run:
                continue
            assert "${{ inputs." not in run, f"run: block interpolates inputs directly: {run!r}"
            assert "${{ github.event." not in run, (
                f"run: block interpolates github.event directly: {run!r}"
            )
            assert "${{ secrets." not in run, f"run: block interpolates secrets directly: {run!r}"

    def test_mastodon_token_referenced_exactly_once_and_only_under_env(self):
        steps_referencing_secret = []
        for step in _iter_steps(self.data):
            run = step.get("run") or ""
            with_block = step.get("with") or {}
            env_block = step.get("env") or {}
            in_run = "secrets.MASTODON_ACCESS_TOKEN" in run
            in_with = any(
                "secrets.MASTODON_ACCESS_TOKEN" in str(v) for v in with_block.values()
            )
            in_env = any(
                "secrets.MASTODON_ACCESS_TOKEN" in str(v) for v in env_block.values()
            )
            if in_run or in_with or in_env:
                steps_referencing_secret.append((step, in_run, in_with, in_env))

        assert len(steps_referencing_secret) == 1, (
            "expected exactly one step referencing secrets.MASTODON_ACCESS_TOKEN, "
            f"found {len(steps_referencing_secret)}"
        )
        _, in_run, in_with, in_env = steps_referencing_secret[0]
        assert in_env is True
        assert in_run is False
        assert in_with is False

    def test_detect_step_reads_before_after_and_post_path_from_env(self):
        detect = next(
            step for step in _iter_steps(self.data) if step.get("id") == "detect"
        )
        env = detect.get("env") or {}
        assert env.get("BEFORE") == "${{ github.event.before }}"
        assert env.get("AFTER") == "${{ github.sha }}"
        assert env.get("POST_PATH") == "${{ inputs.post_path }}"

    def test_substack_gated_steps_check_inputs_substack(self):
        for name in ("Render status, Substack Markdown, and job summary", "Upload Substack Markdown"):
            step = next(s for s in _iter_steps(self.data) if s.get("name") == name)
            assert "inputs.substack" in str(step.get("if", ""))

    def test_mastodon_step_gated_on_instance_non_empty(self):
        step = next(
            s for s in _iter_steps(self.data) if s.get("name") == "Post to Mastodon"
        )
        assert "inputs.mastodon_instance" in str(step.get("if", ""))

    def test_every_step_after_detect_except_the_notice_is_configured_gated(self):
        # The header comment promises that leaving BOTH legs at their default
        # makes the job "do nothing else" after detect + the notice step —
        # so every step that runs after detect, other than the notice step
        # itself, must be gated on at least one leg being configured. Without
        # this, Await/Verify still ran (and waited on a real prod deploy) on
        # an unconfigured site, contradicting the header.
        configured_guard = CONFIGURED_GUARD
        steps = list(_iter_steps(self.data))
        detect_index = next(i for i, s in enumerate(steps) if s.get("id") == "detect")
        for step in steps[detect_index + 1 :]:
            if step.get("name") == "Cross-posting not configured":
                continue
            if step.get("name") == "Check LinkedIn token age":
                # Schedule-only; gated on inputs.linkedin itself (asserted in
                # test_token_age_check_runs_only_on_schedule_with_linkedin_on).
                continue
            if_expr = str(step.get("if", ""))
            assert configured_guard in if_expr, (
                f"step {step.get('name')!r} runs after detect but its `if:` "
                f"({if_expr!r}) does not guard on ({configured_guard}) — an "
                "unconfigured site (mastodon_instance: '' and substack: "
                "false) would still run it, contradicting the header comment's "
                "promise that an unconfigured run does nothing else"
            )

    # --- LinkedIn leg, targets, schedule -------------------------------------

    def test_linkedin_input_is_boolean_default_false(self):
        linkedin = self.data[True]["workflow_call"]["inputs"]["linkedin"]
        assert linkedin["type"] == "boolean"
        assert linkedin["default"] is False
        assert "LinkedIn" in linkedin["description"]

    def test_linkedin_token_minted_input_is_string_default_empty(self):
        minted = self.data[True]["workflow_call"]["inputs"]["linkedin_token_minted"]
        assert minted["type"] == "string"
        assert minted["default"] == ""
        assert "YYYY-MM-DD" in minted["description"]

    def test_targets_input_is_string_default_all(self):
        targets = self.data[True]["workflow_call"]["inputs"]["targets"]
        assert targets["type"] == "string"
        assert targets["default"] == "all"
        for leg in ("all", "mastodon", "linkedin", "substack"):
            assert leg in targets["description"]

    def test_linkedin_access_token_secret_is_optional(self):
        secrets = self.data[True]["workflow_call"]["secrets"]
        assert secrets["LINKEDIN_ACCESS_TOKEN"]["required"] is False

    def test_linkedin_token_referenced_exactly_once_and_only_under_env(self):
        refs = _steps_referencing(self.data, "secrets.LINKEDIN_ACCESS_TOKEN")
        assert len(refs) == 1, (
            "expected exactly one step referencing secrets.LINKEDIN_ACCESS_TOKEN, "
            f"found {len(refs)}"
        )
        step, in_run, in_with, in_env = refs[0]
        assert step.get("name") == "Post to LinkedIn"
        assert in_env is True
        assert in_run is False
        assert in_with is False

    def test_detect_is_skipped_on_schedule(self):
        detect = next(step for step in _iter_steps(self.data) if step.get("id") == "detect")
        assert "github.event_name != 'schedule'" in str(detect.get("if", ""))

    def test_token_age_check_runs_only_on_schedule_with_linkedin_on(self):
        step = _step_named(self.data, "Check LinkedIn token age")
        if_expr = str(step.get("if", ""))
        assert "github.event_name == 'schedule'" in if_expr
        assert "inputs.linkedin" in if_expr
        assert "check-linkedin-token" in step["run"]
        assert step["env"] == {"LINKEDIN_TOKEN_MINTED": "${{ inputs.linkedin_token_minted }}"}

    def test_every_other_step_after_detect_waits_on_detect_changed(self):
        # On a schedule detect is skipped, so `changed` is empty and every
        # posting step stays off: the weekly run only checks the token age.
        steps = list(_iter_steps(self.data))
        detect_index = next(i for i, s in enumerate(steps) if s.get("id") == "detect")
        for step in steps[detect_index + 1 :]:
            if step.get("name") in ("Cross-posting not configured", "Check LinkedIn token age"):
                continue
            assert "steps.detect.outputs.changed == 'true'" in str(step.get("if", "")), step.get(
                "name"
            )

    def test_not_configured_notice_needs_all_three_legs_off_and_no_schedule(self):
        if_expr = str(_step_named(self.data, "Cross-posting not configured").get("if", ""))
        assert "inputs.mastodon_instance == ''" in if_expr
        assert "inputs.substack == false" in if_expr
        assert "inputs.linkedin == false" in if_expr
        assert "github.event_name != 'schedule'" in if_expr

    @pytest.mark.parametrize(
        "name, leg",
        [
            ("Render status, Substack Markdown, and job summary", "substack"),
            ("Upload Substack Markdown", "substack"),
            ("Post to Mastodon", "mastodon"),
            ("Post to LinkedIn", "linkedin"),
        ],
    )
    def test_each_leg_is_gated_on_targets(self, name, leg):
        if_expr = str(_step_named(self.data, name).get("if", ""))
        assert f"(inputs.targets == 'all' || inputs.targets == '{leg}')" in if_expr

    def test_linkedin_step_gated_on_inputs_linkedin_and_configured(self):
        step = _step_named(self.data, "Post to LinkedIn")
        if_expr = str(step.get("if", ""))
        assert "steps.detect.outputs.changed == 'true' && inputs.linkedin &&" in if_expr
        assert CONFIGURED_GUARD in if_expr

    def test_linkedin_step_env_and_run(self):
        step = _step_named(self.data, "Post to LinkedIn")
        assert step["env"] == {
            "LINKEDIN_ACCESS_TOKEN": "${{ secrets.LINKEDIN_ACCESS_TOKEN }}",
            "LINKEDIN_TOKEN_MINTED": "${{ inputs.linkedin_token_minted }}",
            "DRY_RUN": "${{ inputs.dry_run }}",
        }
        assert "post-linkedin" in step["run"]
        assert "--dry-run" in step["run"]
        assert '"$DRY_RUN" = "true"' in step["run"]

    def test_linkedin_step_runs_after_mastodon(self):
        names = [s.get("name") for s in _iter_steps(self.data)]
        assert names.index("Post to LinkedIn") == names.index("Post to Mastodon") + 1


class TestCrossPostTemplate:
    """`examples/site/.github/workflows/cross-post.yml` — the thin caller."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        self.data = _load_yaml(CROSS_POST_TEMPLATE)
        self.lines = _raw_lines(CROSS_POST_TEMPLATE)

    def test_push_trigger_branches_main_only(self):
        push = self.data[True]["push"]
        assert push["branches"] == ["main"]

    def test_push_paths_include_posts_glob_and_fixture_negations(self):
        paths = self.data[True]["push"]["paths"]
        assert "_posts/**" in paths
        assert "!_posts/2099-*" in paths
        assert "!_posts/*-e2e-*" in paths

    def test_workflow_dispatch_post_path_input(self):
        inputs = self.data[True]["workflow_dispatch"]["inputs"]
        post_path = inputs["post_path"]
        assert post_path["type"] == "string"
        assert post_path["required"] is True

    def test_workflow_dispatch_dry_run_input(self):
        inputs = self.data[True]["workflow_dispatch"]["inputs"]
        dry_run = inputs["dry_run"]
        assert dry_run["type"] == "boolean"
        assert dry_run["default"] is True

    def test_workflow_dispatch_visibility_input(self):
        inputs = self.data[True]["workflow_dispatch"]["inputs"]
        visibility = inputs["visibility"]
        assert visibility["type"] == "choice"
        assert visibility["options"] == ["public", "unlisted", "direct"]
        assert visibility["default"] == "public"

    def test_permissions_are_contents_and_actions_read(self):
        # A reusable's requested permissions are CAPPED by the caller's own
        # `permissions:` block — GitHub rejects the call outright ("requesting
        # 'actions: read', but is only allowed 'actions: none'") if the
        # template doesn't grant everything the reusable declares. The
        # reusable declares actions:read for await-prod-deploy, so the
        # template must too (mirrors cms-media-roundtrip.yml's template).
        assert self.data["permissions"] == {"contents": "read", "actions": "read"}

    def test_permissions_are_a_superset_of_the_reusable_s(self):
        reusable = _load_yaml(CROSS_POST_REUSABLE)
        reusable_perms = reusable["permissions"]
        template_perms = self.data["permissions"]
        missing = {
            k: v for k, v in reusable_perms.items() if template_perms.get(k) != v
        }
        assert missing == {}, (
            f"reusable requests permissions {reusable_perms} but the template "
            f"only grants {template_perms} — missing/mismatched: {missing}. A "
            "workflow_call reusable is capped by its caller's permissions, so "
            "an under-grant here fails the call at job setup."
        )

    def test_single_job_calls_the_platform_reusable(self):
        jobs = self.data["jobs"]
        assert len(jobs) == 1
        (job,) = jobs.values()
        assert job["uses"].startswith(
            "Adam-S-Daniel/cms-platform/.github/workflows/cross-post.yml@"
        )

    def test_reusable_pin_is_a_version_tag_matching_platform_ref(self):
        (job,) = self.data["jobs"].values()
        uses_ref = job["uses"].rsplit("@", 1)[-1]
        assert VERSION_TAG_RE.match(uses_ref), f"not a vX.Y.Z tag: {uses_ref}"
        assert job["with"]["platform_ref"] == uses_ref, (
            "the `uses:@ref` pin and `with: platform_ref:` must name the SAME "
            f"version: uses@{uses_ref} vs platform_ref={job['with']['platform_ref']}"
        )

    def test_reusable_pin_matches_this_repo_s_current_canonical_version(self):
        (job,) = self.data["jobs"].values()
        uses_ref = job["uses"].rsplit("@", 1)[-1]
        assert uses_ref == _canonical_version(), (
            f"template pins {uses_ref}, but plugin.json's version implies "
            f"{_canonical_version()} is canonical"
        )

    def test_with_block_forwards_dispatch_inputs_and_leaves_legs_off_by_default(self):
        (job,) = self.data["jobs"].values()
        with_block = job["with"]
        assert with_block["mastodon_instance"] == ""
        assert with_block["substack"] is False
        assert with_block["post_path"] == "${{ inputs.post_path || '' }}"
        assert with_block["dry_run"] == "${{ inputs.dry_run || false }}"
        assert with_block["visibility"] == "${{ inputs.visibility || 'public' }}"
        assert "prod_url" in with_block

    def test_secrets_map_forwards_mastodon_access_token(self):
        (job,) = self.data["jobs"].values()
        assert job["secrets"]["MASTODON_ACCESS_TOKEN"] == "${{ secrets.MASTODON_ACCESS_TOKEN }}"

    def test_third_party_uses_pinned_to_full_sha_or_platform_tag(self):
        entries = _uses_entries(self.lines)
        assert entries, "expected at least one `uses:` step"
        for raw_line, value in entries:
            if value.startswith(CMS_PLATFORM_PREFIX):
                ref = value.rsplit("@", 1)[-1]
                assert VERSION_TAG_RE.match(ref), f"platform ref is not a vX.Y.Z tag: {value}"
                continue
            assert "@" in value, f"uses line missing @ref: {value}"
            ref = value.rsplit("@", 1)[-1]
            assert FULL_SHA_RE.match(ref), f"uses ref is not a full 40-char sha: {value}"
            after_at = raw_line.split("@", 1)[-1]
            assert "#" not in after_at, f"trailing comment on uses line: {raw_line!r}"

    # --- LinkedIn leg, targets, schedule -------------------------------------

    def test_weekly_schedule_trigger(self):
        schedule = self.data[True]["schedule"]
        assert schedule == [{"cron": "23 6 * * 1"}]

    def test_run_name_has_a_schedule_branch(self):
        run_name = self.data["run-name"]
        assert "github.event_name == 'schedule'" in run_name
        assert "format('scheduled — {0}', github.event.schedule)" in run_name
        assert "format('push — {0} @{1}', github.ref_name, github.actor)" in run_name
        assert "format('manual — @{0}', github.actor)" in run_name

    def test_workflow_dispatch_targets_input(self):
        targets = self.data[True]["workflow_dispatch"]["inputs"]["targets"]
        assert targets["type"] == "choice"
        assert targets["options"] == ["all", "mastodon", "linkedin", "substack"]
        assert targets["default"] == "all"

    def test_with_block_leaves_linkedin_off_and_forwards_minted_and_targets(self):
        (job,) = self.data["jobs"].values()
        with_block = job["with"]
        assert with_block["linkedin"] is False
        assert with_block["linkedin_token_minted"] == "${{ vars.LINKEDIN_TOKEN_MINTED || '' }}"
        assert with_block["targets"] == "${{ inputs.targets || 'all' }}"

    def test_with_keys_are_all_reusable_inputs(self):
        (job,) = self.data["jobs"].values()
        reusable_inputs = _load_yaml(CROSS_POST_REUSABLE)[True]["workflow_call"]["inputs"]
        unknown = set(job["with"]) - set(reusable_inputs)
        assert unknown == set(), f"template passes inputs the reusable does not declare: {unknown}"

    def test_secrets_map_forwards_both_tokens(self):
        (job,) = self.data["jobs"].values()
        assert job["secrets"] == {
            "MASTODON_ACCESS_TOKEN": "${{ secrets.MASTODON_ACCESS_TOKEN }}",
            "LINKEDIN_ACCESS_TOKEN": "${{ secrets.LINKEDIN_ACCESS_TOKEN }}",
        }
