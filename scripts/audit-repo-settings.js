#!/usr/bin/env node
"use strict";
/*
 * audit-repo-settings.js — repo settings as code (#109): audit the LIVE
 * GitHub repo settings + rulesets of every repo declared in repo-settings.yml
 * against the manifest, and make drift LOUD.
 *
 * THE PROBLEM (the v0.1.40 incident): repo settings live only in GitHub's
 * API/UI — a change leaves no commit, PR, or review trail. When the #80
 * host-loop work needed to know WHY `delete_branch_on_merge` was false on
 * both consumers, there was no record anywhere; the platform's own
 * cleanup-stale-fixture-branches.yml header even assumed it was true. And
 * the two consumers' `main` rulesets had silently skewed (jodidaniel lost
 * required_status_checks + non_fast_forward) with no guard analogous to the
 * platform-pin-consistency check.
 *
 * THE FIX (audit-first, human apply — Design A of the #109 spike):
 *   - repo-settings.yml (repo root) declares the desired state, every leaf
 *     with a `# why:` comment. Effective flags per repo = shallow
 *     merge(settings_defaults, repos.<r>.settings); ruleset bodies mirror
 *     the REST ruleset PUT payload and live in a shared ruleset_library;
 *     Actions-permissions (sha_pinning_required + fork-PR approval_policy) are
 *     a THIRD surface — their own GET/PUT endpoints (NOT repos/{owner}/{repo}),
 *     shallow merge(actions_permissions_defaults, repos.<r>.actions_permissions),
 *     keyed to MANAGED_ACTIONS_PERMISSION_KEYS. The sha_pinning PUT echoes the
 *     live enabled/allowed_actions; the fork-PR endpoint 422s on a PRIVATE repo
 *     and is treated as an operational SKIP (informational, never drift).
 *     Environments (GET/PUT repos/{owner}/{repo}/environments/{name}) are a
 *     FOURTH surface, keyed to MANAGED_ENVIRONMENT_KEYS (reviewers/wait_timer/
 *     prevent_self_review) — declared per repo only, with NO
 *     environments_defaults (an environment is repo-specific by nature). A 404
 *     GET means the environment doesn't exist yet: that is DRIFT
 *     (desired-but-absent), never an operational skip. ENV_FIX_FORBIDDEN names
 *     environments --fix must never write, at ANY drift state (absent or
 *     existing-but-drifted) — currently just `repo-settings`, which gates this
 *     very apply path's own reviewer approval (see repo-settings-apply.yml); an
 *     approved apply holds administration:write, so letting --fix touch its own
 *     gating environment could strip the required reviewer and leave every
 *     future apply unattended. Drift on a fix-forbidden environment is still a
 *     finding (still reaches the tracking issue) — it is only ever reported as
 *     a skipped fix item, never PUT.
 *     Dependabot security-analysis (vulnerability_alerts + automated_security_
 *     fixes) is a FIFTH surface, keyed to MANAGED_SECURITY_ANALYSIS_KEYS, shallow
 *     merge(security_analysis_defaults, repos.<r>.security_analysis) like the
 *     Actions-permissions surface above — but unlike every other surface in this
 *     file, each key is its OWN GET/PUT/DELETE endpoint where the desired VALUE
 *     is carried by the HTTP METHOD (PUT enables, DELETE disables), never a
 *     request body. A 404 GET reads as genuinely disabled (safe only because
 *     fetchActionsPermissions has already proven Administration:Read on this
 *     token/repo earlier in the same fetchLive call — see fetchSecurityAnalysis's
 *     header comment); a 403 is an operational SKIP (informational, never drift),
 *     matching the fork-PR-approval 422 posture above. Grouped security updates
 *     has NO repo-level REST endpoint at all and is therefore permanently out of
 *     scope — it stays a manual settings-UI toggle, not an oversight.
 *   - default mode: READ-ONLY drift scan. Exit 0 clean / 2 drift / 1
 *     operational failure. Drift is a finding, not a breakage.
 *   - --issue: the audit-scheduled-runs.js tracking-issue lifecycle on the
 *     platform repo — a single `ci`-labelled issue found via a hidden
 *     marker, opened on first drift, commented ONLY when the drift
 *     FINGERPRINT changes (sha256 of the canonical sorted findings, stored
 *     in a hidden <!-- drift-fingerprint: … --> block), auto-closed with a
 *     clean-run comment when drift clears. Exits 0 when drift was found AND
 *     the issue was filed — a red run means the ALERTING LAYER broke, not
 *     "settings drifted" (the audit-scheduled-runs.js exit contract).
 *   - --fix [--yes]: HUMAN-run apply. Prints the exact plan (repo / key:
 *     live -> desired; per-ruleset JSON diff); without --yes it is
 *     plan-only (exit 2 if changes are pending). With --yes it PATCHes only
 *     the drifted flag keys, PUTs drifted rulesets (matched BY NAME) with
 *     the full library body, POSTs manifest-only rulesets, PUTs drifted or
 *     absent environments (full manifest body, one PUT per environment) EXCEPT
 *     any ENV_FIX_FORBIDDEN name, PUTs/DELETEs drifted security-analysis keys
 *     (bodyless — vulnerability_alerts before automated_security_fixes on an
 *     enable, the reverse order on a disable, since the latter DEPENDS on the
 *     former being on), then re-audits and exits non-zero if drift
 *     persists. Live-only rulesets are NEVER deleted (reported as unmanaged;
 *     no --prune in v1); `default_branch` (FIX_FORBIDDEN_KEYS) is audited but
 *     never PATCHed, and an ENV_FIX_FORBIDDEN environment is CREATE-ONLY: it may
 *     be PUT when ABSENT (the body comes from the manifest, so the only reachable
 *     outcome is the declared protected state) but NEVER when it exists and has
 *     drifted, because an approved apply holds administration:write and could
 *     otherwise strip its own required reviewer and make every future apply
 *     unattended; a live ruleset carrying an unknown non-allowlisted
 *     field is SKIPPED by --fix (a manifest-built PUT would drop the field —
 *     the lossy-PUT guard).
 *
 * AUTH: reads resolve a per-owner env token REPO_SETTINGS_READ_<OWNER_SLUG>
 * (owner uppercased, non-alnum -> "_": ADAM_S_DANIEL, JODIDANIEL) — the
 * read-only fine-grained PATs the repo-settings-audit workflow injects —
 * falling back to ambient GH_TOKEN / gh auth. --fix ALWAYS uses the ambient
 * gh auth and ignores those env vars (they are read-only and would 403 — a
 * designed tripwire; the operator's own admin auth is the intended write
 * path). Issue writes always use ambient auth (GH_TOKEN in the workflow).
 *
 * ANTI-FLAP NORMALIZATION (the pure helpers, unit-tested by
 * e2e/repo-settings-audit.test.js against live-captured fixtures):
 * flags compare only manifest-declared keys; ruleset server keys are
 * stripped; a DEFAULT-valued pull_request dismissal_restriction
 * ({enabled:false,allowed_actors:[]} — org-repo noise on jodidaniel) is
 * stripped while any other value is drift; required_status_checks[].
 * integration_id is allowlist-dropped; rules / checks / bypass_actors /
 * ref_name conditions are sorted before compare; live-only rule-parameter
 * keys are informational, not drift; environment reviewers (projected from
 * the live `protection_rules[].reviewers[].reviewer.id` shape down to
 * {type,id}) are sorted by (type,id) before compare, and an absent
 * wait_timer/required_reviewers rule normalizes to GitHub's own defaults
 * (0 / false) rather than counting as drift against nothing.
 *
 * Usage:
 *   node scripts/audit-repo-settings.js [--manifest repo-settings.yml]
 *     [--repo OWNER/REPO]... [--issue] [--label ci] [--fix [--yes]]
 *     [--dry-run] [--json]
 *
 * Pure helpers are exported for unit tests; the require.main guard keeps
 * the CLI from running on import.
 */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

// Hidden marker that identifies THE tracking issue among the label's issues —
// stable across releases; never change it or the audit will open a duplicate.
const MARKER = "<!-- repo-settings-drift-audit -->";
const ISSUE_TITLE =
  "Live GitHub repo settings have drifted from repo-settings.yml (automated audit)";
// The tracking issue lives on the platform repo (where the manifest lives),
// regardless of which repo drifted.
const ISSUE_REPO = "Adam-S-Daniel/cms-platform";

// The SSOT of repo-flag keys the manifest may declare and --fix may PATCH.
// e2e/repo-settings-manifest.test.js asserts every manifest settings key is
// in this list, and loadManifest() hard-fails on any other key — so --fix
// can never PATCH an arbitrary field.
const MANAGED_REPO_KEYS = [
  "default_branch",
  "delete_branch_on_merge",
  "allow_squash_merge",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_auto_merge",
  "allow_update_branch",
  "squash_merge_commit_title",
  "squash_merge_commit_message",
  "merge_commit_title",
  "merge_commit_message",
  "use_squash_pr_title_as_default",
  "has_issues",
  "has_wiki",
  "has_projects",
  "has_discussions",
  "web_commit_signoff_required",
];

// Identity keys: audited for drift, but --fix REFUSES to PATCH them — a
// default-branch change is a human-paced migration, never an automated
// revert. Drift on one prints "manual-only key" and stays a finding.
const FIX_FORBIDDEN_KEYS = ["default_branch"];

// The SSOT of Actions-permissions keys the manifest may declare and --fix may
// PUT. These are NOT part of repos/{owner}/{repo} — each is its OWN GET/PUT
// endpoint, so they are a surface SEPARATE from MANAGED_REPO_KEYS (audited via
// diffActionsPermissions, applied via actionsPuts, never mixed into the
// flag-PATCH body). loadManifest() hard-fails on any other actions key.
//   - sha_pinning_required -> GET/PUT ACTIONS_PERMISSIONS_ENDPOINT. The PUT
//     ECHOES the live `enabled` + `allowed_actions` back alongside the desired
//     sha_pinning_required, so enforcing it can never disable Actions or narrow
//     the allowed-actions policy as a side effect.
//   - approval_policy -> GET/PUT FORK_PR_APPROVAL_ENDPOINT. This endpoint
//     returns HTTP 422 ("not allowed for private repositories") on a PRIVATE
//     repo; fetchLive marks it {skipped:true} and diffActionsPermissions turns
//     that into an operational SKIP (informational, never drift) — matching the
//     read/exit contract. The correct value for "all outside collaborators" is
//     the SHORT form `all_external_contributors` (verified against the live
//     API — NOT `require_approval_for_all_outside_collaborators`).
const MANAGED_ACTIONS_PERMISSION_KEYS = [
  "sha_pinning_required",
  "approval_policy",
];
const ACTIONS_PERMISSIONS_ENDPOINT = "actions/permissions";
const FORK_PR_APPROVAL_ENDPOINT =
  "actions/permissions/fork-pr-contributor-approval";

// The SSOT of Dependabot security-analysis keys the manifest may declare and
// --fix may enable/disable. A FIFTH surface, and it looks nothing like the
// four above: `vulnerability_alerts` and `automated_security_fixes` are NOT
// part of `repos/{owner}/{repo}` (unlike MANAGED_REPO_KEYS) and are NOT a
// shared GET-then-diff-then-PUT-the-whole-object endpoint the way Actions
// permissions or an environment are — each key is its OWN standalone
// GET/PUT/DELETE endpoint, and on THIS surface the desired VALUE is carried
// by the HTTP METHOD, not by a request body: PUT enables, DELETE disables,
// and both take NO body at all. Every other managed surface in this file
// PATCHes or PUTs a JSON value; --fix's writes here are silent by
// comparison — `applyWrite` has to special-case a bodyless call (see below).
// Grouped security updates (the "group minor/patch upgrades into one PR"
// toggle) has NO repo-level REST endpoint at all — it isn't part of
// `security_and_analysis`, and there is no dedicated GET/PUT for it — so it
// is deliberately OUT OF SCOPE for this script and stays a manual settings-UI
// toggle. Do not go looking for a way to manage it here; there isn't one.
const MANAGED_SECURITY_ANALYSIS_KEYS = [
  "vulnerability_alerts",
  "automated_security_fixes",
];
const VULNERABILITY_ALERTS_ENDPOINT = "vulnerability-alerts";
const AUTOMATED_SECURITY_FIXES_ENDPOINT = "automated-security-fixes";

// The SSOT of Environment keys the manifest may declare and --fix may PUT.
// A FOURTH surface — GET/PUT repos/{owner}/{repo}/environments/{name}, one
// endpoint PER DECLARED ENVIRONMENT NAME — declared under repos.<repo>.
// environments.<name> with NO shared defaults block (an environment is
// repo-specific; there is no sane cross-repo default for "who reviews this
// gate"). loadManifest() hard-fails on any other environment key, and on a
// reviewer entry missing `type` or carrying a non-numeric `id`.
const MANAGED_ENVIRONMENT_KEYS = [
  "reviewers",
  "wait_timer",
  "prevent_self_review",
];

// Environments --fix must AUDIT (drift is still a finding, still reaches the
// tracking issue) but NEVER WRITE, at any drift state — absent or
// existing-but-drifted. `repo-settings` gates repo-settings-apply.yml's own
// apply job (a required_reviewers rule is what makes that apply
// human-approved rather than unattended); an approved apply run holds
// administration:write, so if --fix could rewrite its own gating environment
// it could remove the required reviewer and leave every future apply
// ungated. This is the environment-level analogue of FIX_FORBIDDEN_KEYS
// (default_branch) above — same posture, just scoped to a whole environment
// rather than one flag. Its first creation is therefore a human action: an
// operator running `--fix --yes` directly with their own admin `gh` auth (see
// repo-settings.yml's `environments.repo-settings` comment), never this
// script's --fix acting alone and never the apply-in-CI workflow (which
// cannot reach its own gate anyway — referencing `environment: repo-settings`
// before it exists auto-creates an UNPROTECTED one, and the workflow's own
// verification step then refuses to proceed without a required_reviewers
// rule).
const ENV_FIX_FORBIDDEN = ["repo-settings"];

// GitHub's branch/tag ruleset rule types (REST "rules" enum) — the manifest
// lint rejects a typo'd rule type before it ever reaches a PUT.
const KNOWN_RULE_TYPES = [
  "creation",
  "update",
  "deletion",
  "required_linear_history",
  "merge_queue",
  "required_deployments",
  "required_signatures",
  "pull_request",
  "required_status_checks",
  "non_fast_forward",
  "commit_message_pattern",
  "commit_author_email_pattern",
  "committer_email_pattern",
  "branch_name_pattern",
  "tag_name_pattern",
  "file_path_restriction",
  "max_file_path_length",
  "file_extension_restriction",
  "max_file_size",
  "workflows",
  "code_scanning",
];

// Server-assigned ruleset keys stripped before compare (they can never be
// declared, so they can never be drift).
const RULESET_SERVER_KEYS = [
  "id",
  "node_id",
  "source",
  "source_type",
  "created_at",
  "updated_at",
  "_links",
  "current_user_can_bypass",
];
// The PUT-payload keys a ruleset body may carry. Anything else live is an
// UNKNOWN field: tolerated on audit (informational `ruleset-unknown-field`),
// but --fix skips the ruleset (a manifest-built PUT would drop the field).
const RULESET_BODY_KEYS = [
  "name",
  "target",
  "enforcement",
  "conditions",
  "rules",
  "bypass_actors",
];
// jodidaniel (org repo) decorates pull_request parameters with a
// dismissal_restriction the user-owned repos never see. The DEFAULT value is
// pure noise and is stripped; any NON-default value is a real policy and
// therefore drift (DRIFT_ON_EXTRA_PARAM_KEYS).
const DEFAULT_DISMISSAL_RESTRICTION = { enabled: false, allowed_actors: [] };
const DRIFT_ON_EXTRA_PARAM_KEYS = ["dismissal_restriction"];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function argAll(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1])
      out.push(process.argv[i + 1]);
  }
  return out;
}

function flag(name) {
  return process.argv.includes(`--${name}`);
}

// ── Resolve the `yaml` parser robustly (check-platform-pin-consistency.js
// pattern) — lazily, so importing the pure helpers never needs it. ──────────
let YAML = null;
function loadYaml() {
  if (YAML) return YAML;
  const candidates = [
    undefined, // standard node resolution (script's own node_modules chain)
    path.resolve(__dirname, "..", "e2e", "node_modules"),
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(process.cwd(), "e2e", "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    try {
      const resolved = base
        ? require.resolve("yaml", { paths: [base] })
        : require.resolve("yaml");
      YAML = require(resolved);
      return YAML;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Cannot resolve the `yaml` parser. Install it (e.g. `cd e2e && npm ci`) " +
      "before running this audit.",
  );
}

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

// Per-owner read-token env name: owner uppercased, non-alnum -> "_".
// "Adam-S-Daniel" -> REPO_SETTINGS_READ_ADAM_S_DANIEL; "jodidaniel" ->
// REPO_SETTINGS_READ_JODIDANIEL.
function ownerSlug(owner) {
  return String(owner)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
}

function tokenEnvName(owner) {
  return `REPO_SETTINGS_READ_${ownerSlug(owner)}`;
}

// Canonical JSON: object keys sorted recursively, so deep equality and the
// drift fingerprint are independent of API/manifest key order.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  }
  return v === undefined ? "null" : JSON.stringify(v);
}

function deepEqual(a, b) {
  return canonical(a) === canonical(b);
}

// Effective repo flags: shallow merge of the shared defaults and the repo's
// own overrides — only manifest-declared keys are ever compared or PATCHed.
function effectiveSettings(manifest, repo) {
  const entry = (manifest.repos || {})[repo] || {};
  return { ...(manifest.settings_defaults || {}), ...(entry.settings || {}) };
}

// Effective Actions-permissions for a repo: shallow merge of the shared
// defaults and the repo's own overrides — only MANAGED_ACTIONS_PERMISSION_KEYS
// are ever compared or PUT.
function effectiveActionsPermissions(manifest, repo) {
  const entry = (manifest.repos || {})[repo] || {};
  return {
    ...(manifest.actions_permissions_defaults || {}),
    ...(entry.actions_permissions || {}),
  };
}

// Effective security-analysis settings for a repo: shallow merge of the
// shared defaults and the repo's own overrides — only
// MANAGED_SECURITY_ANALYSIS_KEYS are ever compared or written. Same shape as
// effectiveActionsPermissions above (there is no environments-style "no
// defaults block" carve-out here: unlike a reviewer list, "alerts on" is a
// sane default for every repo in the fleet).
function effectiveSecurityAnalysis(manifest, repo) {
  const entry = (manifest.repos || {})[repo] || {};
  return {
    ...(manifest.security_analysis_defaults || {}),
    ...(entry.security_analysis || {}),
  };
}

// Desired rulesets for a repo: { liveName -> library body } (the map key is
// the ruleset's NAME on the live repo; the value names a ruleset_library
// entry). loadManifest() already validated every reference resolves.
function desiredRulesets(manifest, repo) {
  const entry = (manifest.repos || {})[repo] || {};
  const out = {};
  for (const [name, libName] of Object.entries(entry.rulesets || {})) {
    out[name] = (manifest.ruleset_library || {})[libName];
  }
  return out;
}

// Desired environments for a repo: { name -> declared body }. Deliberately NO
// shallow-merge-with-defaults step (unlike effectiveSettings /
// effectiveActionsPermissions above) — environments are repo-specific by
// nature and the manifest declares no environments_defaults block.
function desiredEnvironments(manifest, repo) {
  const entry = (manifest.repos || {})[repo] || {};
  return entry.environments || {};
}

// Order-normalize a ruleset body: rules by type, required_status_checks by
// context, bypass_actors by (actor_type, actor_id), ref_name include/exclude
// lexically. Applied to BOTH sides so ordering can never flap the audit.
function sortRuleset(body) {
  const out = JSON.parse(JSON.stringify(body || {}));
  if (Array.isArray(out.rules)) {
    out.rules.sort((a, b) => String(a.type).localeCompare(String(b.type)));
    for (const rule of out.rules) {
      const p = rule.parameters;
      if (p && Array.isArray(p.required_status_checks)) {
        p.required_status_checks.sort((a, b) =>
          String(a.context).localeCompare(String(b.context)),
        );
      }
    }
  }
  if (Array.isArray(out.bypass_actors)) {
    out.bypass_actors.sort(
      (a, b) =>
        String(a.actor_type).localeCompare(String(b.actor_type)) ||
        (a.actor_id || 0) - (b.actor_id || 0),
    );
  }
  const rn = out.conditions && out.conditions.ref_name;
  if (rn) {
    if (Array.isArray(rn.include)) rn.include.sort();
    if (Array.isArray(rn.exclude)) rn.exclude.sort();
  }
  return out;
}

// Project a LIVE ruleset onto the comparable PUT-payload shape:
//   - strip server-assigned keys (never declarable);
//   - collect unknown top-level keys (tolerated on audit, fix-skipped);
//   - strip a DEFAULT-valued dismissal_restriction (org-repo noise) and
//     every required_status_checks[].integration_id (server-assigned);
//   - sort everything (sortRuleset).
function normalizeRuleset(live) {
  const copy = JSON.parse(JSON.stringify(live || {}));
  const unknownKeys = [];
  const projected = {};
  for (const [k, v] of Object.entries(copy)) {
    if (RULESET_SERVER_KEYS.includes(k)) continue;
    if (!RULESET_BODY_KEYS.includes(k)) {
      unknownKeys.push(k);
      continue;
    }
    projected[k] = v;
  }
  for (const rule of projected.rules || []) {
    const p = rule.parameters;
    if (!p) continue;
    if (
      p.dismissal_restriction &&
      deepEqual(p.dismissal_restriction, DEFAULT_DISMISSAL_RESTRICTION)
    ) {
      delete p.dismissal_restriction;
    }
    for (const check of p.required_status_checks || [])
      delete check.integration_id;
  }
  return { projected: sortRuleset(projected), unknownKeys };
}

// Per-facet ruleset diff. Compared exhaustively (these WERE the observed
// consumer skew): target, enforcement, conditions, bypass_actors, the SET of
// rule types in both directions, and — for rule types present on both sides —
// every manifest-declared parameter key. Live-only parameter keys are
// informational (fixSkip: a manifest-built PUT would drop them), EXCEPT the
// DRIFT_ON_EXTRA_PARAM_KEYS (a surviving non-default dismissal_restriction is
// a real policy difference).
function diffRuleset(repo, name, live, desired, findings, informational) {
  for (const facet of [
    "target",
    "enforcement",
    "conditions",
    "bypass_actors",
  ]) {
    const l = facet === "bypass_actors" ? live[facet] || [] : live[facet];
    const d = facet === "bypass_actors" ? desired[facet] || [] : desired[facet];
    if (!deepEqual(l, d)) {
      findings.push({
        repo,
        kind: "ruleset-drift",
        ruleset: name,
        facet,
        live: l,
        desired: d,
      });
    }
  }
  const liveRules = live.rules || [];
  const desiredRules = desired.rules || [];
  const liveTypes = liveRules.map((r) => r.type);
  const desiredTypes = desiredRules.map((r) => r.type);
  for (const t of desiredTypes) {
    if (!liveTypes.includes(t)) {
      findings.push({
        repo,
        kind: "ruleset-drift",
        ruleset: name,
        facet: `rule:${t}`,
        live: null,
        desired: "present",
      });
    }
  }
  for (const t of liveTypes) {
    if (!desiredTypes.includes(t)) {
      findings.push({
        repo,
        kind: "ruleset-drift",
        ruleset: name,
        facet: `rule:${t}`,
        live: "present",
        desired: null,
      });
    }
  }
  for (const dRule of desiredRules) {
    const lRule = liveRules.find((r) => r.type === dRule.type);
    if (!lRule) continue;
    const dp = dRule.parameters || {};
    const lp = lRule.parameters || {};
    for (const key of Object.keys(dp)) {
      if (!deepEqual(dp[key], lp[key])) {
        findings.push({
          repo,
          kind: "ruleset-drift",
          ruleset: name,
          facet: `rule:${dRule.type}.${key}`,
          live: lp[key] === undefined ? null : lp[key],
          desired: dp[key],
        });
      }
    }
    for (const key of Object.keys(lp)) {
      if (key in dp) continue;
      if (DRIFT_ON_EXTRA_PARAM_KEYS.includes(key)) {
        findings.push({
          repo,
          kind: "ruleset-drift",
          ruleset: name,
          facet: `rule:${dRule.type}.${key}`,
          live: lp[key],
          desired: null,
        });
      } else {
        informational.push({
          repo,
          kind: "rule-param-extra",
          ruleset: name,
          rule: dRule.type,
          key,
          // The VALUE, not just the key. #313: this line named
          // `require_extra_approval_for_unattributed_changes` on both consumers
          // and stopped there, so "is the live value a real protection or
          // GitHub's inert default?" — the one question that decides whether the
          // fix is `declare it` or `declare it as false` — could only be answered
          // by reading the live ruleset by hand. It was `true`, a genuine
          // protection a manifest-built PUT would have silently turned off.
          value: lp[key],
          fixSkip: true,
        });
      }
    }
  }
}

// Full-repo diff: flags (manifest-declared keys only) + every managed
// ruleset (matched BY NAME) + the ruleset SET in both directions. Returns
// { findings, informational } — findings are drift (exit 2 / issue-worthy),
// informational lines never gate.
function diffRepo({
  repo,
  desiredSettings,
  desiredRulesets: desired,
  liveRepo,
  liveRulesets,
}) {
  const findings = [];
  const informational = [];
  const live = liveRepo || {};
  for (const key of Object.keys(desiredSettings || {})) {
    // A managed merge-setting key ABSENT from the live repo object is NOT drift.
    // GitHub gates the merge-setting keys (delete_branch_on_merge, allow_*_merge,
    // allow_auto_merge, allow_update_branch, use_squash_pr_title_as_default,
    // squash_merge_commit_*, merge_commit_*) behind the CONTENTS permission
    // (read+WRITE), so a correct read-only Administration:Read CI token gets a
    // repo object with those keys ENTIRELY ABSENT. Comparing desired vs.
    // undefined would manufacture the "17 bogus drifts" this audit used to abort
    // over. Emit an INFORMATIONAL line (never gates, never drift) instead — the
    // exact skip pattern the fork-approval 422 case uses. --fix runs under admin
    // gh auth (which HAS Contents) so it sees every key and reconciles it. Only
    // keys that ARE present are diffed.
    if (!(key in live)) {
      informational.push({
        repo,
        kind: "flag-not-visible",
        key,
        reason:
          "not visible to this token — merge-settings need Contents; reconciled via `--fix` with admin gh auth",
        fixSkip: true,
      });
      continue;
    }
    const liveVal = live[key];
    if (!deepEqual(liveVal, desiredSettings[key])) {
      findings.push({
        repo,
        kind: "flag-drift",
        key,
        live: liveVal === undefined ? null : liveVal,
        desired: desiredSettings[key],
        manualOnly: FIX_FORBIDDEN_KEYS.includes(key),
      });
    }
  }
  const liveByName = new Map((liveRulesets || []).map((r) => [r.name, r]));
  for (const [name, body] of Object.entries(desired || {})) {
    const live = liveByName.get(name);
    if (!live) {
      findings.push({ repo, kind: "ruleset-missing", ruleset: name });
      continue;
    }
    const { projected, unknownKeys } = normalizeRuleset(live);
    for (const key of unknownKeys) {
      informational.push({
        repo,
        kind: "ruleset-unknown-field",
        ruleset: name,
        key,
        fixSkip: true,
      });
    }
    diffRuleset(
      repo,
      name,
      projected,
      sortRuleset({ name, ...body }),
      findings,
      informational,
    );
  }
  for (const live of liveRulesets || []) {
    if (!(live.name in (desired || {}))) {
      // NEVER deleted by --fix (no --prune in v1) — but an undeclared live
      // ruleset is exactly the invisible-settings class #109 exists for.
      findings.push({
        repo,
        kind: "ruleset-unmanaged",
        ruleset: live.name,
        id: live.id,
      });
    }
  }
  return { findings, informational };
}

// Actions-permissions diff — a surface SEPARATE from the repo-flag keys (two
// standalone GET/PUT endpoints, not repos/{owner}/{repo}). Only the
// MANAGED_ACTIONS_PERMISSION_KEYS the manifest declares are compared.
//   - sha_pinning_required (ACTIONS_PERMISSIONS_ENDPOINT): plain scalar compare.
//   - approval_policy (FORK_PR_APPROVAL_ENDPOINT): when fetchLive marked the
//     endpoint {skipped:true} (HTTP 422 on a PRIVATE repo), this is an
//     operational SKIP — an informational line, NEVER a drift finding.
// `live` is fetchLive's { permissions, forkApproval } bundle.
function diffActionsPermissions(repo, desired, live, findings, informational) {
  const perms = (live && live.permissions) || {};
  const fork = (live && live.forkApproval) || {};
  if ("sha_pinning_required" in (desired || {})) {
    const liveVal = perms.sha_pinning_required;
    if (!deepEqual(liveVal, desired.sha_pinning_required)) {
      findings.push({
        repo,
        kind: "actions-permission-drift",
        key: "sha_pinning_required",
        endpoint: ACTIONS_PERMISSIONS_ENDPOINT,
        live: liveVal === undefined ? null : liveVal,
        desired: desired.sha_pinning_required,
      });
    }
  }
  if ("approval_policy" in (desired || {})) {
    if (fork.skipped) {
      informational.push({
        repo,
        kind: "actions-permission-skipped",
        key: "approval_policy",
        endpoint: FORK_PR_APPROVAL_ENDPOINT,
        reason: fork.reason || "endpoint unavailable",
        fixSkip: true,
      });
    } else {
      const liveVal = fork.approval_policy;
      if (!deepEqual(liveVal, desired.approval_policy)) {
        findings.push({
          repo,
          kind: "actions-permission-drift",
          key: "approval_policy",
          endpoint: FORK_PR_APPROVAL_ENDPOINT,
          live: liveVal === undefined ? null : liveVal,
          desired: desired.approval_policy,
        });
      }
    }
  }
}

// Maps a MANAGED_SECURITY_ANALYSIS_KEYS entry to the fetchSecurityAnalysis()
// bundle field that carries it and the endpoint constant used for both the
// GET (fetchSecurityAnalysis) and the enable/disable write (buildFixPlan).
// One place to keep the key <-> field <-> endpoint triple in step, since
// diffSecurityAnalysis and buildFixPlan both need all three.
const SECURITY_ANALYSIS_FIELDS = {
  vulnerability_alerts: {
    liveKey: "vulnerabilityAlerts",
    endpoint: VULNERABILITY_ALERTS_ENDPOINT,
  },
  automated_security_fixes: {
    liveKey: "automatedSecurityFixes",
    endpoint: AUTOMATED_SECURITY_FIXES_ENDPOINT,
  },
};

// Security-analysis diff — a FIFTH surface, separate from every other one
// above (own GET/PUT/DELETE endpoint PER KEY, not repos/{owner}/{repo} and
// not one shared endpoint the way Actions permissions is). `live` is
// fetchSecurityAnalysis()'s { vulnerabilityAlerts, automatedSecurityFixes }
// bundle — each entry either { enabled } or the operational-skip shape
// { skipped: true, reason }. Only the MANAGED_SECURITY_ANALYSIS_KEYS the
// manifest declares are ever compared. A live entry that is missing
// entirely (the surface was never fetched — see fetchLive's gating) is
// treated the same as an explicit {skipped:true}: informational, never
// drift, because there is nothing to diff against.
function diffSecurityAnalysis(repo, desired, live, findings, informational) {
  for (const key of MANAGED_SECURITY_ANALYSIS_KEYS) {
    if (!(key in (desired || {}))) continue;
    const { liveKey, endpoint } = SECURITY_ANALYSIS_FIELDS[key];
    const entry = (live || {})[liveKey];
    if (!entry || entry.skipped) {
      informational.push({
        repo,
        kind: "security-analysis-skipped",
        key,
        endpoint,
        reason: (entry && entry.reason) || "endpoint not read",
        fixSkip: true,
      });
      continue;
    }
    if (!deepEqual(entry.enabled, desired[key])) {
      findings.push({
        repo,
        kind: "security-analysis-drift",
        key,
        endpoint,
        live: entry.enabled === undefined ? null : entry.enabled,
        desired: desired[key],
      });
    }
  }
}

// Order-normalize a reviewers list to [{type,id}] sorted by (type, id).
// Applied to BOTH the projected-live and the manifest-declared side so
// reviewer order can never flap the audit (mirrors sortRuleset's treatment of
// bypass_actors above).
function sortReviewers(list) {
  return (list || [])
    .map((r) => ({ type: r && r.type, id: r && r.id }))
    .sort(
      (a, b) =>
        String(a.type).localeCompare(String(b.type)) ||
        (a.id || 0) - (b.id || 0),
    );
}

// Project a LIVE environment (GET repos/{owner}/{repo}/environments/{name})
// onto the manifest-comparable shape {reviewers, wait_timer,
// prevent_self_review}. The live API buries all three inside
// `protection_rules`, one entry per rule TYPE:
//   {type:"required_reviewers", reviewers:[{type:"User", reviewer:{id,...}}], prevent_self_review}
//   {type:"wait_timer", wait_timer:N}
// A rule that is simply ABSENT from `protection_rules` means GitHub's own
// default for that leaf (wait_timer 0, prevent_self_review false, reviewers
// []) — never drift against nothing.
function normalizeEnvironment(live) {
  const rules = (live && live.protection_rules) || [];
  const reviewersRule = rules.find((r) => r.type === "required_reviewers");
  const waitRule = rules.find((r) => r.type === "wait_timer");
  const reviewers = ((reviewersRule && reviewersRule.reviewers) || []).map(
    (r) => ({
      type: r.type,
      id: r.reviewer && r.reviewer.id,
    }),
  );
  return {
    reviewers: sortReviewers(reviewers),
    wait_timer: (waitRule && waitRule.wait_timer) || 0,
    prevent_self_review:
      (reviewersRule && reviewersRule.prevent_self_review) || false,
  };
}

// Environments diff — a FOURTH managed surface (own GET/PUT endpoint PER
// DECLARED NAME, repos/{owner}/{repo}/environments/{name}). `desired` is
// desiredEnvironments()'s { name -> body } map; `live` is fetchEnvironments()'s
// { name -> body | {absent:true} } bundle. Only MANAGED_ENVIRONMENT_KEYS the
// manifest declares are ever compared. A 404-absent environment is DRIFT
// (desired-but-missing) — `kind: "environment-absent"` — never an operational
// skip; an existing-but-different environment is `kind: "environment-drift"`.
// Every finding carries `fixForbidden` (ENV_FIX_FORBIDDEN.includes(name)) so
// describeFinding/buildFixPlan can render the manual-only posture without
// re-importing the constant. `informational` is accepted (mirrors
// diffActionsPermissions's signature) but unused today — there is no
// operational-skip case on this surface, only drift.
function diffEnvironments(repo, desired, live, findings, informational) {
  for (const [name, body] of Object.entries(desired || {})) {
    const liveEnv = (live || {})[name];
    const absent = !liveEnv || liveEnv.absent;
    const normalized = absent ? null : normalizeEnvironment(liveEnv);
    const fixForbidden = ENV_FIX_FORBIDDEN.includes(name);
    for (const key of Object.keys(body || {})) {
      const desiredVal =
        key === "reviewers" ? sortReviewers(body.reviewers) : body[key];
      if (absent) {
        findings.push({
          repo,
          kind: "environment-absent",
          environment: name,
          key,
          live: null,
          desired: desiredVal,
          fixForbidden,
        });
        continue;
      }
      const liveVal = normalized[key];
      if (!deepEqual(liveVal, desiredVal)) {
        findings.push({
          repo,
          kind: "environment-drift",
          environment: name,
          key,
          live: liveVal,
          desired: desiredVal,
          fixForbidden,
        });
      }
    }
  }
  void informational; // no operational-skip case on this surface (see header note)
}

// Order-stable drift fingerprint: sha256 over the SORTED canonical findings.
// Stored in the tracking issue so persistent, unchanged drift is commented
// exactly once (the run-ids dedupe analog).
function fingerprint(findings) {
  const canon = (findings || []).map(canonical).sort();
  return crypto.createHash("sha256").update(canon.join("\n")).digest("hex");
}

function fingerprintBlock(fp) {
  return `<!-- drift-fingerprint: ${fp} -->`;
}

// Every fingerprint already reported on the issue (body + comments) — the
// hidden blocks are authoritative.
function extractReportedFingerprints(texts) {
  const out = new Set();
  for (const t of texts || []) {
    if (typeof t !== "string") continue;
    for (const m of t.matchAll(
      /<!--\s*drift-fingerprint:\s*([0-9a-f]{64})\s*-->/g,
    ))
      out.add(m[1]);
  }
  return out;
}

function describeFinding(f) {
  if (f.kind === "flag-drift") {
    return (
      `flag \`${f.key}\`: live \`${JSON.stringify(f.live)}\` -> manifest ` +
      `\`${JSON.stringify(f.desired)}\`${f.manualOnly ? " (manual-only key — --fix will not touch it)" : ""}`
    );
  }
  if (f.kind === "actions-permission-drift") {
    return (
      `actions permission \`${f.key}\` (${f.endpoint}): live ` +
      `\`${JSON.stringify(f.live)}\` -> manifest \`${JSON.stringify(f.desired)}\``
    );
  }
  if (f.kind === "security-analysis-drift") {
    return (
      `security setting \`${f.key}\` (${f.endpoint}): live ` +
      `\`${JSON.stringify(f.live)}\` -> manifest \`${JSON.stringify(f.desired)}\``
    );
  }
  if (f.kind === "ruleset-missing")
    return `ruleset \`${f.ruleset}\`: declared in the manifest, absent live`;
  if (f.kind === "ruleset-unmanaged") {
    return `ruleset \`${f.ruleset}\`: live but NOT in the manifest (unmanaged — declare it or delete it by hand; --fix never deletes)`;
  }
  if (f.kind === "environment-absent" || f.kind === "environment-drift") {
    const live =
      f.kind === "environment-absent"
        ? "absent live"
        : `live \`${JSON.stringify(f.live)}\``;
    // ENV_FIX_FORBIDDEN is CREATE-ONLY, so the suffix MUST distinguish the two
    // states or it actively misinforms. It previously said "--fix will not create
    // or write it" for both — describing the superseded strict rule — while
    // `--fix --yes` went on to create an absent one, which is correct behaviour
    // and the opposite of what the operator was told.
    const suffix = !f.fixForbidden
      ? ""
      : f.kind === "environment-absent"
        ? " (fix-forbidden environment, but ABSENT — `--fix --yes` WILL create it from the " +
          "manifest; creating cannot weaken it)"
        : " (fix-forbidden environment that already EXISTS — `--fix` will NOT write it, because " +
          "an approved apply could strip its own required reviewer; reconcile by hand)";
    return (
      `environment \`${f.environment}\` / \`${f.key}\`: ${live} -> ` +
      `manifest \`${JSON.stringify(f.desired)}\`${suffix}`
    );
  }
  // ruleset-drift
  return (
    `ruleset \`${f.ruleset}\` / ${f.facet}: live \`${JSON.stringify(f.live)}\` -> ` +
    `manifest \`${JSON.stringify(f.desired)}\``
  );
}

function describeInformational(f) {
  if (f.kind === "flag-not-visible") {
    return (
      `flag \`${f.key}\`: ${f.reason} ` +
      `(informational, not drift; the read-only audit cannot see Contents-gated merge settings)`
    );
  }
  if (f.kind === "actions-permission-skipped") {
    return (
      `actions permission \`${f.key}\` (${f.endpoint}): SKIPPED — ${f.reason} ` +
      `(operational skip on a private repo, not drift; --fix leaves it untouched)`
    );
  }
  if (f.kind === "ruleset-unknown-field") {
    return (
      `ruleset \`${f.ruleset}\`: live body carries unknown field \`${f.key}\` ` +
      `(tolerated; --fix SKIPS this ruleset — a manifest-built PUT would drop it)`
    );
  }
  if (f.kind === "security-analysis-skipped") {
    return (
      `security setting \`${f.key}\` (${f.endpoint}): SKIPPED — ${f.reason} ` +
      `(this is an OPERATIONAL skip — the token cannot read this surface — NOT drift; ` +
      `--fix leaves it untouched)`
    );
  }
  return (
    `ruleset \`${f.ruleset}\` / rule ${f.rule}: live-only parameter \`${f.key}\` = ` +
    `${JSON.stringify(f.value)} — undeclared, so --fix SKIPS this ruleset (a ` +
    `manifest-built PUT would drop it). Declare it in the manifest to converge.`
  );
}

// The flag keys this scan could NOT verify: `flag-not-visible` means the
// read-only PAT never SAW the live value, so an unqualified "OK" would claim a
// match that was never checked. Surfacing them is ALL this does — unverifiable
// is NOT drift: it never enters `findings`, never files/updates an issue, and
// never changes an exit code (see runIssueLifecycle + main).
function unverifiableKeys(informational) {
  return (informational || [])
    .filter((f) => f.kind === "flag-not-visible")
    .map((f) => f.key);
}

// Per-repo OK line. With nothing unverifiable the wording is UNCHANGED; with
// any, it says how many flags went unchecked instead of implying a full match.
function repoOkLine(repo, rulesetCount, informational) {
  const line = `== ${repo}: OK (flags + ${rulesetCount} ruleset(s) + actions permissions match)`;
  const keys = unverifiableKeys(informational);
  return keys.length
    ? `${line} — ${keys.length} flag(s) UNVERIFIABLE (need Contents)`
    : line;
}

// ONE collapsed notice per repo naming every unverifiable key (it used to be a
// notice per key, which drowned the report on the 11 Contents-gated flags).
function describeUnverifiable(keys) {
  return (
    `${keys.length} flag(s) UNVERIFIABLE — \`${keys.join("`, `")}\` not visible to this ` +
    `token (merge settings need Contents; reconciled via \`--fix\` with admin gh auth). ` +
    `Informational, not drift.`
  );
}

// The clean-scan summary. "match … on every scanned repo" would OVERSTATE the
// scan whenever some flags were never visible, so qualify it then; with nothing
// unverifiable the sentence stays byte-identical to what it has always been.
function cleanScanSummary(informational) {
  const keys = unverifiableKeys(informational);
  if (!keys.length)
    return "OK — live settings match repo-settings.yml on every scanned repo.";
  return (
    `OK — live settings match repo-settings.yml on every scanned repo, EXCEPT ` +
    `${keys.length} flag(s) the read-only PAT cannot see (Contents-gated merge settings) ` +
    `— UNVERIFIABLE, not drift.`
  );
}

// Grouped markdown findings: one section per repo.
function renderFindings(findings, informational) {
  const byRepo = new Map();
  for (const f of findings || []) {
    if (!byRepo.has(f.repo))
      byRepo.set(f.repo, { findings: [], informational: [] });
    byRepo.get(f.repo).findings.push(f);
  }
  for (const f of informational || []) {
    if (!byRepo.has(f.repo))
      byRepo.set(f.repo, { findings: [], informational: [] });
    byRepo.get(f.repo).informational.push(f);
  }
  const lines = [];
  for (const [repo, group] of byRepo) {
    lines.push(`**${repo}**`);
    for (const f of group.findings) lines.push(`- ${describeFinding(f)}`);
    for (const f of group.informational)
      lines.push(`- _${describeInformational(f)}_`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function buildIssueBody({ findings, informational, nowIso }) {
  return [
    MARKER,
    fingerprintBlock(fingerprint(findings)),
    "",
    "The daily **repo-settings drift audit** found live GitHub repo settings /",
    "rulesets that no longer match `repo-settings.yml` (scanned at " +
      nowIso +
      ").",
    "",
    "Settings drift has no PR to go red on — this issue is the alert.",
    "",
    renderFindings(findings, informational),
    "",
    "**What to do — RATIFY or REVERT, same day:**",
    "- **RATIFY**: PR the live value into `repo-settings.yml` with a `# why:` comment, or",
    "- **REVERT**: `node scripts/audit-repo-settings.js --fix --repo <owner/repo>` (review the plan), then re-run with `--yes`.",
    "",
    "Never leave live != manifest. The audit comments here when the drift",
    "fingerprint CHANGES (never a new issue) and closes this automatically",
    "once a scan comes back clean.",
    "",
    "_Filed automatically by the `repo-settings-audit` workflow (cms-platform)._",
  ].join("\n");
}

function buildComment({ findings, informational, nowIso }) {
  return [
    fingerprintBlock(fingerprint(findings)),
    "",
    `The drift fingerprint changed (scanned at ${nowIso}) — current findings:`,
    "",
    renderFindings(findings, informational),
  ].join("\n");
}

function buildCloseComment({ nowIso }) {
  return (
    `Live settings match repo-settings.yml again (scanned at ${nowIso}) — closing. ` +
    "The audit will reopen a fresh tracking issue if they drift apart again."
  );
}

// ── manifest loading / validation ───────────────────────────────────────────

function loadManifest(manifestPath) {
  const raw = fs.readFileSync(manifestPath, "utf8");
  const doc = loadYaml().parse(raw);
  if (!doc || typeof doc !== "object")
    throw new Error(`${manifestPath}: empty/unparseable manifest`);
  if (doc.version !== 1)
    throw new Error(
      `${manifestPath}: unsupported version ${doc.version} (expected 1)`,
    );
  if (
    !doc.repos ||
    typeof doc.repos !== "object" ||
    Object.keys(doc.repos).length === 0
  ) {
    throw new Error(`${manifestPath}: no repos declared`);
  }
  const lib = doc.ruleset_library || {};
  for (const [repo, entry] of Object.entries(doc.repos)) {
    for (const key of Object.keys((entry && entry.settings) || {})) {
      if (!MANAGED_REPO_KEYS.includes(key)) {
        throw new Error(
          `${manifestPath}: repos.${repo}.settings.${key} is not a MANAGED_REPO_KEY`,
        );
      }
    }
    for (const key of Object.keys((entry && entry.actions_permissions) || {})) {
      if (!MANAGED_ACTIONS_PERMISSION_KEYS.includes(key)) {
        throw new Error(
          `${manifestPath}: repos.${repo}.actions_permissions.${key} is not a MANAGED_ACTIONS_PERMISSION_KEY`,
        );
      }
    }
    for (const [key, value] of Object.entries(
      (entry && entry.security_analysis) || {},
    )) {
      if (!MANAGED_SECURITY_ANALYSIS_KEYS.includes(key)) {
        throw new Error(
          `${manifestPath}: repos.${repo}.security_analysis.${key} is not a MANAGED_SECURITY_ANALYSIS_KEY`,
        );
      }
      // These two endpoints are enable/disable only (PUT vs. DELETE with no
      // body — see the MANAGED_SECURITY_ANALYSIS_KEYS header comment), so a
      // string/number value is meaningless: there is no PUT payload to carry
      // it. Fail loudly at load time rather than let buildFixPlan's
      // `f.desired ? "PUT" : "DELETE"` truthiness check silently coerce a
      // typo'd `"true"` (a non-empty string, hence truthy) into the SAME
      // outcome as the real boolean and mask the mistake.
      if (typeof value !== "boolean") {
        throw new Error(
          `${manifestPath}: repos.${repo}.security_analysis.${key} must be a boolean ` +
            `(enable/disable only), got ${JSON.stringify(value)}`,
        );
      }
    }
    for (const [name, libName] of Object.entries(
      (entry && entry.rulesets) || {},
    )) {
      if (!lib[libName]) {
        throw new Error(
          `${manifestPath}: repos.${repo}.rulesets.${name} references unknown ruleset_library entry "${libName}"`,
        );
      }
    }
    for (const [envName, envBody] of Object.entries(
      (entry && entry.environments) || {},
    )) {
      const envPrefix = `${manifestPath}: repos.${repo}.environments.${envName}`;
      for (const key of Object.keys(envBody || {})) {
        if (!MANAGED_ENVIRONMENT_KEYS.includes(key)) {
          throw new Error(
            `${envPrefix}.${key} is not a MANAGED_ENVIRONMENT_KEY`,
          );
        }
      }
      for (const reviewer of (envBody && envBody.reviewers) || []) {
        if (
          !reviewer ||
          typeof reviewer.type !== "string" ||
          reviewer.type.length === 0
        ) {
          throw new Error(`${envPrefix}.reviewers entry is missing "type"`);
        }
        if (typeof reviewer.id !== "number" || !Number.isFinite(reviewer.id)) {
          throw new Error(
            `${envPrefix}.reviewers entry has a non-numeric "id"`,
          );
        }
      }
    }
  }
  for (const key of Object.keys(doc.settings_defaults || {})) {
    if (!MANAGED_REPO_KEYS.includes(key)) {
      throw new Error(
        `${manifestPath}: settings_defaults.${key} is not a MANAGED_REPO_KEY`,
      );
    }
  }
  for (const key of Object.keys(doc.actions_permissions_defaults || {})) {
    if (!MANAGED_ACTIONS_PERMISSION_KEYS.includes(key)) {
      throw new Error(
        `${manifestPath}: actions_permissions_defaults.${key} is not a MANAGED_ACTIONS_PERMISSION_KEY`,
      );
    }
  }
  for (const [key, value] of Object.entries(
    doc.security_analysis_defaults || {},
  )) {
    if (!MANAGED_SECURITY_ANALYSIS_KEYS.includes(key)) {
      throw new Error(
        `${manifestPath}: security_analysis_defaults.${key} is not a MANAGED_SECURITY_ANALYSIS_KEY`,
      );
    }
    if (typeof value !== "boolean") {
      throw new Error(
        `${manifestPath}: security_analysis_defaults.${key} must be a boolean (enable/disable ` +
          `only), got ${JSON.stringify(value)}`,
      );
    }
  }
  return doc;
}

// ── gh-backed plumbing ──────────────────────────────────────────────────────

function ghApi(endpoint, { method, fields, input, token } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  for (const f of fields || []) args.push("-f", f);
  if (input !== undefined) args.push("--input", "-");
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    input,
  });
}

// The read token for a repo's owner: the per-owner read-only PAT when set
// (the workflow path), ambient gh auth otherwise (the operator path).
// fixMode always returns null (ambient) — the read-only PATs would 403 the
// writes, and locally the operator's own admin auth is the intended path.
function readToken(owner, fixMode) {
  if (fixMode) return null;
  return process.env[tokenEnvName(owner)] || null;
}

// Fetch the live repo + FULL ruleset bodies. Fails LOUD-and-DISTINCT on a
// 403/404 or any unexpected gh error (an OPERATIONAL failure — exit 1, "the
// alerting layer is broken", never drift).
//
// NO merge-flag canary here (removed): GitHub gates the repo MERGE-SETTING keys
// (delete_branch_on_merge, allow_*_merge, allow_auto_merge, allow_update_branch,
// use_squash_pr_title_as_default, squash_merge_commit_*, merge_commit_*) behind
// the CONTENTS permission (read+WRITE), so a CORRECT read-only
// Administration:Read PAT gets a repo object with those keys ENTIRELY ABSENT.
// Asserting `delete_branch_on_merge` here false-negatived and aborted every CI
// run. diffRepo now skips absent managed keys as informational
// `flag-not-visible` (never drift), and THE reliable Administration:Read gate
// lives downstream in fetchActionsPermissions — GET actions/permissions has NO
// public exemption, so a token truly lacking the surface 403s there
// (operational failure, correctly). fetchLive always calls it, so that gate
// still runs on every scan.
//
// `api` is injectable (defaults to the real gh-backed ghApi) so the fetch path
// is unit-testable without a network / gh auth. `declaredEnvNames` (default
// []) is the repo's manifest-declared environment names — appended LAST with
// a no-op default so every existing positional call site keeps working
// unchanged; fetchEnvironments is only ever called when the repo actually
// declares environments (no wasted calls on the two-thirds of repos that
// don't). `desiredSecurityKeys` (default []) is the same gating shape one
// positional argument further out, for the SAME reason plus one more: every
// EXISTING call site in e2e/repo-settings-audit.test.js builds a `fakeApi`
// whose route map is an exact, closed set that throws `fakeApi: unrouted
// endpoint` on anything not in it, so an unconditional new fetch here would
// break every one of those tests even though none of them changed. Gating on
// the caller having actually declared a security_analysis key keeps every
// 3-and-4-arg call passing unchanged and avoids two calls per scan on repos
// (there are none today, but the manifest doesn't forbid it) that manage
// nothing on this surface. Do NOT make this fetch unconditional.
function fetchLive(
  repo,
  token,
  api = ghApi,
  declaredEnvNames = [],
  desiredSecurityKeys = [],
) {
  const liveRepo = JSON.parse(api(`repos/${repo}`, { token }));
  const list = JSON.parse(
    api(`repos/${repo}/rulesets?per_page=100`, { token }),
  );
  const liveRulesets = [];
  for (const r of Array.isArray(list) ? list : []) {
    // Org-level rulesets can surface on an org repo's list; they are not this
    // repo's to manage (or PUT) — scope to Repository-sourced ones.
    if (r.source_type && r.source_type !== "Repository") continue;
    liveRulesets.push(
      JSON.parse(api(`repos/${repo}/rulesets/${r.id}`, { token })),
    );
  }
  // fetchActionsPermissions runs BEFORE fetchSecurityAnalysis below — that
  // ordering is load-bearing, not incidental (see fetchSecurityAnalysis's own
  // header comment for why): it is THE Administration:Read gate for the whole
  // scan, and only once it has succeeded is a 404 on the security-analysis
  // endpoints safe to read as "genuinely disabled" rather than "token can't
  // see this repo at all". Do not reorder these two calls.
  const liveActionsPermissions = fetchActionsPermissions(repo, token, api);
  const liveEnvironments = declaredEnvNames.length
    ? fetchEnvironments(repo, declaredEnvNames, token, api)
    : {};
  const liveSecurityAnalysis = desiredSecurityKeys.length
    ? fetchSecurityAnalysis(repo, token, api)
    : {};
  return {
    liveRepo,
    liveRulesets,
    liveActionsPermissions,
    liveEnvironments,
    liveSecurityAnalysis,
  };
}

// The Actions-permissions surface (two standalone endpoints). This is THE
// Administration:Read gate for the whole scan (fetchLive always calls it):
// GET actions/permissions requires Administration:Read with NO public
// exemption, so a response missing the admin-visible `enabled` boolean means
// the token lacks that surface — an OPERATIONAL failure (exit 1), never silent
// drift against undefined. The fork-pr-contributor-approval endpoint returns
// HTTP 422 on a PRIVATE repo ("not allowed for private repositories"); that ONE
// case is an operational SKIP ({skipped:true}), distinguished from any other
// error which re-throws as an operational failure. `api` is injectable
// (defaults to the real gh-backed ghApi) so the gate is unit-testable.
function fetchActionsPermissions(repo, token, api = ghApi) {
  const permissions = JSON.parse(
    api(`repos/${repo}/${ACTIONS_PERMISSIONS_ENDPOINT}`, { token }),
  );
  if (typeof permissions.enabled !== "boolean") {
    throw new Error(
      `repos/${repo}/${ACTIONS_PERMISSIONS_ENDPOINT} response has no 'enabled' boolean — ` +
        `the token lacks "Administration: Read" (Actions permissions) on ${repo}`,
    );
  }
  let forkApproval;
  try {
    forkApproval = JSON.parse(
      api(`repos/${repo}/${FORK_PR_APPROVAL_ENDPOINT}`, { token }),
    );
  } catch (e) {
    const text = `${(e && e.stderr) || ""}${(e && e.message) || ""}`;
    if (/HTTP 422|not allowed for private repositor/i.test(text)) {
      forkApproval = {
        skipped: true,
        reason:
          "fork-pr-contributor-approval endpoint returns HTTP 422 on a private repo",
      };
    } else {
      throw e;
    }
  }
  return { permissions, forkApproval };
}

// The Dependabot security-analysis surface: two standalone endpoints,
// GET/PUT/DELETE repos/{owner}/{repo}/vulnerability-alerts and
// .../automated-security-fixes, where the enable/disable VALUE is carried by
// the HTTP METHOD rather than a request body — `PUT` = on, `DELETE` = off,
// both bodiless. GET on `vulnerability-alerts` returns HTTP 204 (empty body)
// when enabled and 404 when disabled, with no JSON either way; GET on
// `automated-security-fixes` returns 200 JSON `{enabled, paused}` on current
// GitHub, but tolerates the older/edge 204-empty/404 shape too, because we
// have not verified every account/repo vintage returns the newer shape.
//
// Three things worth being explicit about, because they are the load-bearing
// reasoning and not obvious from the code alone:
//
// (a) A 404 here is read as "the feature is genuinely OFF". That is, on its
// face, backwards from this account's own standing rule that "a GitHub 404
// means NOT AUTHORIZED, not NOT THERE" — and it would be unsound applied in
// isolation. It is sound HERE specifically because fetchLive calls
// fetchActionsPermissions BEFORE this function (see fetchLive's comment on
// that ordering): GET actions/permissions has no public exemption and throws
// a loud operational failure the moment a token lacks Administration:Read on
// this repo, so by the time fetchSecurityAnalysis ever runs, admin-read
// access has ALREADY been proven for this exact token on this exact repo. A
// 404 that survives that gate cannot be a scope problem; it can only be the
// documented "disabled" response. Do not read a 404 here as "disabled" in any
// code path that has not first cleared that gate.
//
// (b) HTTP 403 is an operational SKIP (informational — never drift), not a
// hard failure, and that is a DELIBERATE departure from how this file treats
// every other unexpected-status case (which all rethrow). This surface is
// being bolted onto an ALREADY-GREEN daily audit whose read-only PATs
// (REPO_SETTINGS_READ_*) were minted before MANAGED_SECURITY_ANALYSIS_KEYS
// existed — a token that predates a scope grant is exactly the shape a scan
// runs into on day one of a new managed surface. Throwing here would take the
// WHOLE fleet scan down (every repo, every surface) over one repo's missing
// grant on this one surface, converting a working alerting lane into a
// broken one for a gap that is expected to close as the PATs get re-minted.
// The skip still reports LOUDLY — printReport turns every
// `security-analysis-skipped` informational into a `::notice` per repo via
// describeInformational, so it is never a silent green — matching the exact
// contract the private-repo fork-approval 422 skip already uses in
// fetchActionsPermissions above.
//
// (c) `automated-security-fixes`'s `paused` field is deliberately NOT
// managed here — MANAGED_SECURITY_ANALYSIS_KEYS carries only `enabled`. GitHub
// pauses security fixes on its own (e.g. after a burst of failed CI runs on
// the auto-opened PRs) as a rate-limiting behaviour, not a policy choice this
// manifest should fight; asserting `paused: false` would turn GitHub's own
// backoff into permanent drift.
//
// `api` is injectable (defaults to the real gh-backed ghApi) so the fetch
// path is unit-testable without a network / gh auth.
// A shape failure this module raises ITSELF (as opposed to a gh transport
// error), tagged so the catch below can tell the two apart.
function shapeError(message) {
  const err = new Error(message);
  err.shapeError = true;
  return err;
}

function fetchSecurityAnalysisKey(repo, endpoint, token, api) {
  try {
    const raw = api(`repos/${repo}/${endpoint}`, { token });
    const trimmed = typeof raw === "string" ? raw.trim() : raw;
    if (!trimmed) return { enabled: true }; // HTTP 204, empty body
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw shapeError(
        `repos/${repo}/${endpoint} returned a non-empty, non-JSON body — ` +
          `cannot determine enabled state`,
      );
    }
    if (parsed && typeof parsed.enabled === "boolean") {
      return { enabled: parsed.enabled };
    }
    // Parsed to JSON but carries no boolean `enabled` — an unexpected shape
    // (not the 204-empty case, which is handled above and never reaches
    // JSON.parse at all) is an operational failure, never a silent default.
    throw shapeError(
      `repos/${repo}/${endpoint} returned an unexpected JSON shape (no ` +
        `boolean 'enabled'): ${trimmed}`,
    );
  } catch (e) {
    // A shape error raised by THIS function must never be re-classified by the
    // transport regexes below: its message interpolates the raw response body,
    // so a body merely CONTAINING "Not Found" would otherwise be silently
    // downgraded to `{enabled:false}` — an outcome attributed to something
    // other than what produced it, the same defect class as reading `$?` from
    // the wrong end of a pipe. Rethrow ours first; only gh's own failures
    // reach the status matching.
    if (e && e.shapeError) throw e;
    const text = `${(e && e.stderr) || ""}${(e && e.message) || ""}`;
    if (/HTTP 404|Not Found/i.test(text)) return { enabled: false };
    if (/HTTP 403/.test(text)) {
      return {
        skipped: true,
        reason: `${endpoint} returned HTTP 403 — the read token lacks this surface`,
      };
    }
    throw e;
  }
}

function fetchSecurityAnalysis(repo, token, api = ghApi) {
  return {
    vulnerabilityAlerts: fetchSecurityAnalysisKey(
      repo,
      VULNERABILITY_ALERTS_ENDPOINT,
      token,
      api,
    ),
    automatedSecurityFixes: fetchSecurityAnalysisKey(
      repo,
      AUTOMATED_SECURITY_FIXES_ENDPOINT,
      token,
      api,
    ),
  };
}

// The Environments surface: GET repos/{owner}/{repo}/environments/{name}, one
// call PER DECLARED NAME (there is no "list all environments and filter"
// shortcut needed here — declaredNames already IS the manifest's declared
// list). A 404 means the environment does not exist yet — that is DRIFT
// (desired-but-absent), never an operational failure, so it is represented
// distinctly as `{absent: true}` rather than thrown. Any OTHER error
// (403/500/network) propagates unchanged — loud-and-distinct, matching every
// other fetch* in this file. `api` is injectable (defaults to the real
// gh-backed ghApi) so the fetch path is unit-testable without a network / gh
// auth.
function fetchEnvironments(repo, declaredNames, token, api = ghApi) {
  const out = {};
  for (const name of declaredNames || []) {
    const endpoint = `repos/${repo}/environments/${encodeURIComponent(name)}`;
    try {
      out[name] = JSON.parse(api(endpoint, { token }));
    } catch (e) {
      // Same shape as the fork-approval 422 case above: gh surfaces the status
      // on stderr and/or message, so test BOTH. A 404 is the ONE tolerated
      // status — the environment simply does not exist yet, which diffEnvironments
      // reports as drift. Everything else re-throws unchanged.
      const text = `${(e && e.stderr) || ""}${(e && e.message) || ""}`;
      if (/HTTP 404|Not Found/i.test(text)) {
        out[name] = { absent: true };
        continue;
      }
      throw e;
    }
  }
  return out;
}

function findTrackingIssue(label) {
  const res = JSON.parse(
    ghApi(
      `repos/${ISSUE_REPO}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
    ),
  );
  return (
    (Array.isArray(res) ? res : []).find(
      (i) =>
        !i.pull_request &&
        typeof i.body === "string" &&
        i.body.includes(MARKER),
    ) || null
  );
}

function listIssueComments(number) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = JSON.parse(
      ghApi(
        `repos/${ISSUE_REPO}/issues/${number}/comments?per_page=100&page=${page}`,
      ),
    );
    comments.push(...batch);
    if (batch.length < 100) break;
  }
  return comments;
}

// Best-effort label creation (422 already-exists is the normal case).
function ensureLabel(label) {
  try {
    ghApi(`repos/${ISSUE_REPO}/labels`, {
      fields: [
        `name=${label}`,
        "color=d93f0b",
        "description=Automated CI health tracking (repo-settings drift audit)",
      ],
    });
  } catch {
    /* already exists / races are fine */
  }
}

// ── scan / report / issue / fix drivers ─────────────────────────────────────

function scanRepos(manifest, repos, fixMode) {
  const results = [];
  for (const repo of repos) {
    const owner = repo.split("/")[0];
    const token = readToken(owner, fixMode);
    const envNames = Object.keys(desiredEnvironments(manifest, repo));
    const desiredSecurity = effectiveSecurityAnalysis(manifest, repo);
    let live;
    try {
      live = fetchLive(
        repo,
        token,
        ghApi,
        envNames,
        Object.keys(desiredSecurity),
      );
    } catch (e) {
      const envName = tokenEnvName(owner);
      console.error(
        `repo-settings-audit: FAILED to read ${repo}: ${e.message}`,
      );
      console.error(
        `  This is an OPERATIONAL failure (exit 1), not drift — the audit's read path is broken.\n` +
          `  Check the ${envName} secret/env var (expired? unminted? missing "Administration: Read-only"?)\n` +
          `  or the ambient gh auth. See skills/consumer-repo-provisioning/SKILL.md "Platform-repo secrets".`,
      );
      const err = new Error(`read failure on ${repo}`);
      err.operational = true;
      throw err;
    }
    const diff = diffRepo({
      repo,
      desiredSettings: effectiveSettings(manifest, repo),
      desiredRulesets: desiredRulesets(manifest, repo),
      liveRepo: live.liveRepo,
      liveRulesets: live.liveRulesets,
    });
    // The Actions-permissions surface is diffed SEPARATELY (own endpoints) and
    // its findings/informational merged into the same result buckets.
    diffActionsPermissions(
      repo,
      effectiveActionsPermissions(manifest, repo),
      live.liveActionsPermissions,
      diff.findings,
      diff.informational,
    );
    // The Environments surface, likewise separate (own endpoint per name).
    diffEnvironments(
      repo,
      desiredEnvironments(manifest, repo),
      live.liveEnvironments,
      diff.findings,
      diff.informational,
    );
    // The security-analysis surface (Dependabot alerts + security updates),
    // likewise separate — own GET/PUT/DELETE endpoint per key.
    diffSecurityAnalysis(
      repo,
      desiredSecurity,
      live.liveSecurityAnalysis,
      diff.findings,
      diff.informational,
    );
    results.push({ repo, ...diff, ...live });
  }
  return results;
}

function printReport(results) {
  for (const r of results) {
    const flags = r.findings.filter((f) => f.kind === "flag-drift");
    const actions = r.findings.filter(
      (f) => f.kind === "actions-permission-drift",
    );
    const environments = r.findings.filter(
      (f) => f.kind === "environment-drift" || f.kind === "environment-absent",
    );
    // security-analysis-drift MUST be excluded here too, or it silently
    // miscounts into the `rulesets` bucket below — the same trap the
    // environment findings were added to this exclusion chain to avoid.
    const security = r.findings.filter(
      (f) => f.kind === "security-analysis-drift",
    );
    const rulesets = r.findings.filter(
      (f) =>
        f.kind !== "flag-drift" &&
        f.kind !== "actions-permission-drift" &&
        f.kind !== "environment-drift" &&
        f.kind !== "environment-absent" &&
        f.kind !== "security-analysis-drift",
    );
    if (r.findings.length === 0) {
      console.log(repoOkLine(r.repo, r.liveRulesets.length, r.informational));
    } else {
      console.log(
        `== ${r.repo}: DRIFT — ${flags.length} flag(s), ` +
          `${actions.length} actions-permission(s), ${environments.length} environment(s), ` +
          `${security.length} security-analysis setting(s), ${rulesets.length} ruleset finding(s)`,
      );
      for (const f of r.findings)
        console.log(
          `::error title=repo-settings drift::${r.repo}: ${describeFinding(f)}`,
        );
    }
    const notVisible = unverifiableKeys(r.informational);
    if (notVisible.length) {
      console.log(
        `::notice title=repo-settings::${r.repo}: ${describeUnverifiable(notVisible)}`,
      );
    }
    for (const f of r.informational) {
      if (f.kind === "flag-not-visible") continue; // collapsed into the one notice above
      console.log(
        `::notice title=repo-settings::${r.repo}: ${describeInformational(f)}`,
      );
    }
  }
}

function runIssueLifecycle({ findings, informational, label, dryRun, nowIso }) {
  let issue;
  try {
    issue = findTrackingIssue(label);
  } catch (e) {
    console.error(
      `repo-settings-audit: failed to look up the tracking issue: ${e.message}`,
    );
    return 1;
  }
  if (findings.length === 0) {
    if (issue) {
      console.log(
        `::notice title=Repo settings::Clean scan — closing tracking issue #${issue.number}.`,
      );
      if (!dryRun) {
        try {
          ghApi(`repos/${ISSUE_REPO}/issues/${issue.number}/comments`, {
            fields: [`body=${buildCloseComment({ nowIso })}`],
          });
          ghApi(`repos/${ISSUE_REPO}/issues/${issue.number}`, {
            method: "PATCH",
            fields: ["state=closed", "state_reason=completed"],
          });
        } catch (e) {
          console.error(
            `repo-settings-audit: failed to close issue #${issue.number}: ${e.message}`,
          );
          return 1;
        }
      }
    }
    // Exit 0 even when flags were UNVERIFIABLE — a key this token cannot see is
    // not drift, so it never fails the run and never keeps the issue open.
    console.log(cleanScanSummary(informational));
    return 0;
  }

  // Drift: the ISSUE is the alert; this run stays green once it is filed.
  const summary = `${findings.length} drift finding(s) across ${new Set(findings.map((f) => f.repo)).size} repo(s)`;
  if (!issue) {
    console.log(
      `::notice title=Repo settings::${summary} — opening the tracking issue.`,
    );
    if (!dryRun) {
      ensureLabel(label);
      try {
        const created = JSON.parse(
          ghApi(`repos/${ISSUE_REPO}/issues`, {
            fields: [
              `title=${ISSUE_TITLE}`,
              `body=${buildIssueBody({ findings, informational, nowIso })}`,
              `labels[]=${label}`,
            ],
          }),
        );
        console.log(
          `Opened tracking issue #${created.number}: ${created.html_url}`,
        );
      } catch (e) {
        console.error(
          `repo-settings-audit: failed to open the tracking issue: ${e.message}`,
        );
        return 1;
      }
    } else {
      console.log(
        `(dry-run) would open "${ISSUE_TITLE}" [${label}] with:\n${renderFindings(findings, informational)}`,
      );
    }
    console.log(`ALERT FILED — ${summary}.`);
    return 0;
  }

  let reported;
  try {
    reported = extractReportedFingerprints([
      issue.body,
      ...listIssueComments(issue.number).map((c) => c.body),
    ]);
  } catch (e) {
    console.error(
      `repo-settings-audit: failed to read issue #${issue.number}: ${e.message}`,
    );
    return 1;
  }
  const fp = fingerprint(findings);
  if (reported.has(fp)) {
    console.log(
      `OK — ${summary}; fingerprint already reported on tracking issue #${issue.number}. Nothing new.`,
    );
    return 0;
  }
  console.log(
    `::notice title=Repo settings::${summary} — fingerprint changed; commenting on issue #${issue.number}.`,
  );
  if (!dryRun) {
    try {
      ghApi(`repos/${ISSUE_REPO}/issues/${issue.number}/comments`, {
        fields: [`body=${buildComment({ findings, informational, nowIso })}`],
      });
    } catch (e) {
      console.error(
        `repo-settings-audit: failed to comment on issue #${issue.number}: ${e.message}`,
      );
      return 1;
    }
  } else {
    console.log(
      `(dry-run) would comment:\n${renderFindings(findings, informational)}`,
    );
  }
  console.log(`ALERT UPDATED — ${summary}.`);
  return 0;
}

// Build the fix plan from a scan: per repo, the flag PATCH body (drifted,
// non-forbidden keys only), the ruleset PUTs (drifted, matched by name, full
// library body, skipping lossy-PUT-guarded ones), the ruleset POSTs
// (manifest-only), and everything --fix deliberately will NOT touch.
function buildFixPlan(manifest, results) {
  const plan = [];
  for (const r of results) {
    const desired = desiredRulesets(manifest, r.repo);
    const settings = effectiveSettings(manifest, r.repo);
    const patchBody = {};
    const manualOnly = [];
    for (const f of r.findings) {
      if (f.kind !== "flag-drift") continue;
      if (f.manualOnly) manualOnly.push(f.key);
      else patchBody[f.key] = settings[f.key];
    }
    const skipNames = new Set(
      r.informational.filter((i) => i.fixSkip).map((i) => i.ruleset),
    );
    const driftedNames = new Set(
      r.findings
        .filter((f) => f.kind === "ruleset-drift")
        .map((f) => f.ruleset),
    );
    const liveByName = new Map(r.liveRulesets.map((l) => [l.name, l]));
    const puts = [];
    const skipped = [];
    for (const name of driftedNames) {
      if (skipNames.has(name)) {
        skipped.push(name);
        continue;
      }
      puts.push({
        name,
        id: liveByName.get(name).id,
        body: { name, ...desired[name] },
      });
    }
    const posts = r.findings
      .filter((f) => f.kind === "ruleset-missing")
      .map((f) => ({
        name: f.ruleset,
        body: { name: f.ruleset, ...desired[f.ruleset] },
      }));
    const unmanaged = r.findings
      .filter((f) => f.kind === "ruleset-unmanaged")
      .map((f) => f.ruleset);
    // Actions-permissions PUTs — a surface SEPARATE from the flag PATCH body.
    // sha_pinning_required ECHOES the live enabled/allowed_actions so the PUT
    // can never disable Actions or narrow the allowed-actions policy;
    // approval_policy PUTs only its own field.
    const livePerms =
      (r.liveActionsPermissions && r.liveActionsPermissions.permissions) || {};
    const actionsPuts = [];
    for (const f of r.findings) {
      if (f.kind !== "actions-permission-drift") continue;
      if (f.key === "sha_pinning_required") {
        actionsPuts.push({
          endpoint: `repos/${r.repo}/${ACTIONS_PERMISSIONS_ENDPOINT}`,
          key: f.key,
          body: {
            enabled: livePerms.enabled,
            allowed_actions: livePerms.allowed_actions,
            sha_pinning_required: f.desired,
          },
        });
      } else if (f.key === "approval_policy") {
        actionsPuts.push({
          endpoint: `repos/${r.repo}/${FORK_PR_APPROVAL_ENDPOINT}`,
          key: f.key,
          body: { approval_policy: f.desired },
        });
      }
    }
    // Environments — a FOURTH surface, one PUT per DRIFTED-OR-ABSENT name with
    // the full manifest body (there is one endpoint per environment, not per
    // key, so any drifted key on a name pulls the whole declared body — same
    // shape as the ruleset `puts` above).
    //
    // ENV_FIX_FORBIDDEN is CREATE-ONLY, and the asymmetry is the security
    // property — not a convenience:
    //   - ABSENT  -> may be created. The body comes from the manifest, so the
    //     only reachable outcome is the DECLARED (protected) state. Creating
    //     cannot weaken anything, and it means bootstrapping the gate is a
    //     `--fix --yes` run rather than a click-through in the settings UI.
    //   - EXISTS BUT DRIFTED -> never written. An approved apply-in-CI run holds
    //     administration:write, so if it could UPDATE its own gating environment
    //     it could strip the required reviewer and make EVERY future apply
    //     unattended — one approval buying permanent unattended access. A human
    //     reconciles that; the drift is still reported so it reaches the issue.
    // In practice apply-in-CI can never reach the create path for its own gate:
    // referencing `environment: repo-settings` auto-creates an UNPROTECTED
    // environment before the job's first step, whereupon that workflow's
    // verification step sees no required_reviewers rule and refuses (exit 1). So
    // only a human-run --fix ever bootstraps it, which is the intent.
    const envDesired = desiredEnvironments(manifest, r.repo);
    const envState = new Map(); // name -> { forbidden, absent, drifted }
    for (const f of r.findings) {
      if (f.kind !== "environment-drift" && f.kind !== "environment-absent")
        continue;
      const s = envState.get(f.environment) || {
        forbidden: false,
        absent: false,
        drifted: false,
      };
      s.forbidden = s.forbidden || !!f.fixForbidden;
      if (f.kind === "environment-absent") s.absent = true;
      else s.drifted = true;
      envState.set(f.environment, s);
    }
    const envNamesToFix = [];
    const envManualOnly = [];
    for (const [name, s] of envState) {
      // A forbidden name is fixable ONLY when it is purely absent — never when
      // any drift finding says it already exists in the wrong shape.
      if (!s.forbidden || (s.absent && !s.drifted)) envNamesToFix.push(name);
      else envManualOnly.push(name);
    }
    const envPuts = envNamesToFix.map((name) => ({
      environment: name,
      endpoint: `repos/${r.repo}/environments/${name}`,
      body: envDesired[name],
    }));
    // Security-analysis writes — a FIFTH surface whose "write" is nothing
    // like a PATCH/PUT body: the desired value is carried by the HTTP METHOD
    // (PUT enables, DELETE disables), with no request body at all (see the
    // MANAGED_SECURITY_ANALYSIS_KEYS header comment and applyWrite below).
    //
    // The ORDER these fire in is a real dependency, not cosmetics — Dependabot
    // security updates cannot open a PR resolving an alert that doesn't
    // exist, so `automated_security_fixes` REQUIRES `vulnerability_alerts` to
    // already be on. Concretely:
    //   - ENABLING both: vulnerability_alerts must land FIRST, or the
    //     automated_security_fixes PUT would be turning on a feature whose
    //     prerequisite isn't there yet.
    //   - DISABLING both: automated_security_fixes must land FIRST — undo the
    //     dependent feature before pulling out what it depends on, the
    //     mirror image of the enable case.
    // Every enable is emitted before every disable (rather than interleaving
    // key-by-key) so the ordering stays correct even when one repo drifts in
    // BOTH directions on the same run (one key needs to go on, the other
    // off) — sorting by (desired DESC, fixed key order) rather than by
    // whatever order `r.findings` happened to collect them in.
    const securityFindings = r.findings.filter(
      (f) => f.kind === "security-analysis-drift",
    );
    const ENABLE_ORDER = ["vulnerability_alerts", "automated_security_fixes"];
    const DISABLE_ORDER = ["automated_security_fixes", "vulnerability_alerts"];
    const securityWrites = [
      ...ENABLE_ORDER.map((key) =>
        securityFindings.find((f) => f.key === key && f.desired),
      ).filter(Boolean),
      ...DISABLE_ORDER.map((key) =>
        securityFindings.find((f) => f.key === key && !f.desired),
      ).filter(Boolean),
    ].map((f) => ({
      endpoint: `repos/${r.repo}/${SECURITY_ANALYSIS_FIELDS[f.key].endpoint}`,
      method: f.desired ? "PUT" : "DELETE",
      key: f.key,
      desired: f.desired,
    }));
    if (
      Object.keys(patchBody).length ||
      manualOnly.length ||
      puts.length ||
      posts.length ||
      skipped.length ||
      unmanaged.length ||
      actionsPuts.length ||
      envPuts.length ||
      envManualOnly.length ||
      securityWrites.length
    ) {
      plan.push({
        repo: r.repo,
        patchBody,
        manualOnly,
        puts,
        posts,
        skipped,
        unmanaged,
        actionsPuts,
        envPuts,
        envManualOnly,
        securityWrites,
      });
    }
  }
  return plan;
}

function printFixPlan(plan) {
  if (plan.length === 0) {
    console.log(
      "Fix plan: EMPTY — live settings already match the manifest. Nothing to apply.",
    );
    return;
  }
  console.log("Fix plan (nothing applied without --yes):");
  for (const p of plan) {
    console.log(`== ${p.repo}`);
    for (const [key, value] of Object.entries(p.patchBody)) {
      console.log(
        `   PATCH repos/${p.repo}  ${key} -> ${JSON.stringify(value)}`,
      );
    }
    for (const key of p.manualOnly) {
      console.log(
        `   MANUAL-ONLY key \`${key}\` drifted — --fix refuses to PATCH it; reconcile by hand.`,
      );
    }
    for (const put of p.puts) {
      console.log(
        `   PUT repos/${p.repo}/rulesets/${put.id} ("${put.name}") with the manifest body:`,
      );
      console.log(`     ${JSON.stringify(sortRuleset(put.body))}`);
    }
    for (const put of p.actionsPuts || []) {
      console.log(
        `   PUT ${put.endpoint}  ${put.key} -> ${JSON.stringify(put.body[put.key])}` +
          ` (full body: ${JSON.stringify(put.body)})`,
      );
    }
    for (const post of p.posts) {
      console.log(
        `   POST repos/${p.repo}/rulesets ("${post.name}") — declared but absent live:`,
      );
      console.log(`     ${JSON.stringify(sortRuleset(post.body))}`);
    }
    for (const name of p.skipped) {
      console.log(
        `   SKIPPED ruleset "${name}" — its live body carries an unknown non-allowlisted field ` +
          `(a manifest-built PUT would drop it). Reconcile by hand or extend the manifest.`,
      );
    }
    for (const name of p.unmanaged) {
      console.log(
        `   UNMANAGED live ruleset "${name}" — --fix never deletes; declare it or delete it by hand.`,
      );
    }
    for (const put of p.envPuts || []) {
      console.log(`   PUT ${put.endpoint} with the manifest body:`);
      console.log(`     ${JSON.stringify(put.body)}`);
    }
    for (const name of p.envManualOnly || []) {
      console.log(
        `   FIX-FORBIDDEN environment "${name}" drifted — --fix refuses to write it (it gates ` +
          `this very apply path's own reviewer approval; a write here could remove that gate ` +
          `and leave every future apply unattended). Reconcile by hand.`,
      );
    }
    for (const w of p.securityWrites || []) {
      console.log(
        `   ${w.method} ${w.endpoint}  ${w.key} -> ${JSON.stringify(w.desired)} (no request body)`,
      );
    }
  }
}

function applyFixPlan(plan) {
  for (const p of plan) {
    if (Object.keys(p.patchBody).length) {
      applyWrite(`repos/${p.repo}`, "PATCH", p.patchBody);
    }
    for (const put of p.puts) {
      applyWrite(`repos/${p.repo}/rulesets/${put.id}`, "PUT", put.body);
    }
    for (const post of p.posts) {
      applyWrite(`repos/${p.repo}/rulesets`, "POST", post.body);
    }
    for (const put of p.actionsPuts || []) {
      applyWrite(put.endpoint, "PUT", put.body);
    }
    // envManualOnly names are never written here — buildFixPlan already kept
    // them out of envPuts (see ENV_FIX_FORBIDDEN above).
    for (const put of p.envPuts || []) {
      applyWrite(put.endpoint, "PUT", put.body);
    }
    // Security-analysis writes carry NO body at all — the method IS the
    // value (see MANAGED_SECURITY_ANALYSIS_KEYS above) — so `body` is
    // deliberately omitted here rather than passed as `{}` or `undefined`
    // explicitly; applyWrite's `body === undefined` branch below is what
    // that omission triggers.
    for (const w of p.securityWrites || []) {
      applyWrite(w.endpoint, w.method);
    }
  }
}

// `body === undefined` is a DISTINCT call shape from every other applyWrite
// caller in this file, not an edge case of the same one: the security-
// analysis endpoints (vulnerability-alerts, automated-security-fixes) take NO
// request body on either PUT or DELETE — the method alone carries the
// enable/disable value — so sending `--input -` with an empty/null payload
// there would be sending a body an endpoint that doesn't expect one, not
// "the same write with nothing in it". Every other caller (flag PATCH,
// ruleset PUT/POST, actions-permissions PUT, environment PUT) keeps going
// through the `body` branch completely unchanged — same success log, same
// error lines including the `payload:` line, same thrown `err.operational`.
function applyWrite(endpoint, method, body) {
  if (body === undefined) {
    try {
      ghApi(endpoint, { method });
      console.log(`applied ${method} ${endpoint} (no request body)`);
    } catch (e) {
      console.error(
        `repo-settings-audit: ${method} ${endpoint} FAILED: ${e.message}`,
      );
      const err = new Error(`write failure: ${method} ${endpoint}`);
      err.operational = true;
      throw err;
    }
    return;
  }
  const payload = JSON.stringify(body);
  try {
    ghApi(endpoint, { method, input: payload });
    console.log(`applied ${method} ${endpoint}`);
  } catch (e) {
    // 409/422 = the API rejected the payload (shape change, race). NEVER
    // delete+recreate — print exactly what failed and stop.
    console.error(
      `repo-settings-audit: ${method} ${endpoint} FAILED: ${e.message}`,
    );
    console.error(`  payload: ${payload}`);
    const err = new Error(`write failure: ${method} ${endpoint}`);
    err.operational = true;
    throw err;
  }
}

// ── main ────────────────────────────────────────────────────────────────────

function main() {
  const manifestArg = arg("manifest", "");
  const manifestPath = manifestArg
    ? path.resolve(process.cwd(), manifestArg)
    : path.resolve(__dirname, "..", "repo-settings.yml");
  const issueMode = flag("issue");
  const fixMode = flag("fix");
  const yes = flag("yes");
  const dryRun = flag("dry-run");
  const label = arg("label", "ci");
  const filter = argAll("repo");
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // --issue drives the tracking-issue lifecycle, whose auto-close treats a
  // findings-empty scan as GLOBALLY clean (comments + PATCHes the issue to
  // state=closed). Scoping the scan with --repo would let a clean SUBSET close
  // the alert while another (unscanned) managed repo is still drifted. The
  // shipped daily workflow always scans ALL repos with no --repo; this refuses
  // the unsafe manual combination.
  if (issueMode && filter.length) {
    console.error(
      "repo-settings-audit: --issue audits ALL managed repos (its auto-close treats a clean " +
        "scan as globally clean); drop --repo, or run the scoped scan without --issue.",
    );
    return 1;
  }

  let manifest;
  try {
    manifest = loadManifest(manifestPath);
  } catch (e) {
    console.error(`repo-settings-audit: cannot load manifest: ${e.message}`);
    return 1;
  }

  const allRepos = Object.keys(manifest.repos);
  const repos = filter.length
    ? allRepos.filter((r) => filter.includes(r))
    : allRepos;
  if (filter.length && repos.length !== filter.length) {
    const unknown = filter.filter((r) => !allRepos.includes(r));
    console.error(
      `repo-settings-audit: --repo ${unknown.join(", ")} not declared in ${manifestPath}`,
    );
    return 1;
  }

  let results;
  try {
    results = scanRepos(manifest, repos, fixMode);
  } catch (e) {
    if (!e.operational)
      console.error(`repo-settings-audit: scan failed: ${e.message}`);
    return 1;
  }

  const findings = results.flatMap((r) => r.findings);
  const informational = results.flatMap((r) => r.informational);

  if (flag("json")) {
    console.log(
      JSON.stringify(
        { repos, findings, informational, fingerprint: fingerprint(findings) },
        null,
        2,
      ),
    );
  } else {
    printReport(results);
  }

  if (issueMode) {
    return runIssueLifecycle({
      findings,
      informational,
      label,
      dryRun,
      nowIso,
    });
  }

  if (fixMode) {
    const plan = buildFixPlan(manifest, results);
    printFixPlan(plan);
    if (plan.length === 0) return 0;
    if (!yes) {
      console.log(
        "Plan-only (no --yes): exiting 2 with changes pending. Re-run with --yes to apply.",
      );
      return 2;
    }
    try {
      applyFixPlan(plan);
    } catch (e) {
      if (!e.operational)
        console.error(`repo-settings-audit: apply failed: ${e.message}`);
      return 1;
    }
    // Re-audit: a PATCH silently ignoring a field (or a PUT normalizing one)
    // must not report success. Unfixables (manual-only keys, unmanaged or
    // fix-skipped rulesets) also keep this non-zero — honestly.
    let recheck;
    try {
      recheck = scanRepos(manifest, repos, fixMode);
    } catch (e) {
      if (!e.operational)
        console.error(`repo-settings-audit: re-audit failed: ${e.message}`);
      return 1;
    }
    const remaining = recheck.flatMap((r) => r.findings);
    if (remaining.length) {
      console.error(
        `repo-settings-audit: ${remaining.length} finding(s) PERSIST after apply:`,
      );
      for (const f of remaining)
        console.error(`  ${f.repo}: ${describeFinding(f)}`);
      return 2;
    }
    console.log(
      "Applied + re-audited: live settings now match repo-settings.yml.",
    );
    return 0;
  }

  return findings.length ? 2 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  // Exported for the (w4) regression test: the fix-forbidden suffix must tell
  // the truth about each state, and that is only assertable on the real fn.
  describeFinding,
  // Exported alongside it for the same reason (the security-analysis-skipped
  // regression test needs to assert its wording directly, not through
  // printReport's console.log side effect).
  describeInformational,
  MARKER,
  ISSUE_TITLE,
  ISSUE_REPO,
  MANAGED_REPO_KEYS,
  FIX_FORBIDDEN_KEYS,
  MANAGED_ACTIONS_PERMISSION_KEYS,
  ACTIONS_PERMISSIONS_ENDPOINT,
  FORK_PR_APPROVAL_ENDPOINT,
  MANAGED_ENVIRONMENT_KEYS,
  ENV_FIX_FORBIDDEN,
  MANAGED_SECURITY_ANALYSIS_KEYS,
  VULNERABILITY_ALERTS_ENDPOINT,
  AUTOMATED_SECURITY_FIXES_ENDPOINT,
  KNOWN_RULE_TYPES,
  RULESET_SERVER_KEYS,
  RULESET_BODY_KEYS,
  DEFAULT_DISMISSAL_RESTRICTION,
  DRIFT_ON_EXTRA_PARAM_KEYS,
  ownerSlug,
  tokenEnvName,
  canonical,
  deepEqual,
  loadManifest,
  effectiveSettings,
  effectiveActionsPermissions,
  effectiveSecurityAnalysis,
  desiredRulesets,
  desiredEnvironments,
  sortRuleset,
  sortReviewers,
  normalizeRuleset,
  normalizeEnvironment,
  diffRuleset,
  diffRepo,
  diffActionsPermissions,
  diffEnvironments,
  diffSecurityAnalysis,
  fetchLive,
  fetchActionsPermissions,
  fetchEnvironments,
  fetchSecurityAnalysis,
  fingerprint,
  fingerprintBlock,
  extractReportedFingerprints,
  unverifiableKeys,
  repoOkLine,
  describeUnverifiable,
  cleanScanSummary,
  renderFindings,
  buildIssueBody,
  buildComment,
  buildCloseComment,
  buildFixPlan,
};
