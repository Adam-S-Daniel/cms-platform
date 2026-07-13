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
 *     the full library body, POSTs manifest-only rulesets, then re-audits
 *     and exits non-zero if drift persists. Live-only rulesets are NEVER
 *     deleted (reported as unmanaged; no --prune in v1); `default_branch`
 *     (FIX_FORBIDDEN_KEYS) is audited but never PATCHed; a live ruleset
 *     carrying an unknown non-allowlisted field is SKIPPED by --fix (a
 *     manifest-built PUT would drop the field — the lossy-PUT guard).
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
 * keys are informational, not drift.
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
const MANAGED_ACTIONS_PERMISSION_KEYS = ["sha_pinning_required", "approval_policy"];
const ACTIONS_PERMISSIONS_ENDPOINT = "actions/permissions";
const FORK_PR_APPROVAL_ENDPOINT = "actions/permissions/fork-pr-contributor-approval";

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
const RULESET_BODY_KEYS = ["name", "target", "enforcement", "conditions", "rules", "bypass_actors"];
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
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
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
      const resolved = base ? require.resolve("yaml", { paths: [base] }) : require.resolve("yaml");
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
  return String(owner).toUpperCase().replace(/[^A-Z0-9]/g, "_");
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
        p.required_status_checks.sort((a, b) => String(a.context).localeCompare(String(b.context)));
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
    for (const check of p.required_status_checks || []) delete check.integration_id;
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
  for (const facet of ["target", "enforcement", "conditions", "bypass_actors"]) {
    const l = facet === "bypass_actors" ? live[facet] || [] : live[facet];
    const d = facet === "bypass_actors" ? desired[facet] || [] : desired[facet];
    if (!deepEqual(l, d)) {
      findings.push({ repo, kind: "ruleset-drift", ruleset: name, facet, live: l, desired: d });
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
function diffRepo({ repo, desiredSettings, desiredRulesets: desired, liveRepo, liveRulesets }) {
  const findings = [];
  const informational = [];
  for (const key of Object.keys(desiredSettings || {})) {
    const liveVal = (liveRepo || {})[key];
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
      informational.push({ repo, kind: "ruleset-unknown-field", ruleset: name, key, fixSkip: true });
    }
    diffRuleset(repo, name, projected, sortRuleset({ name, ...body }), findings, informational);
  }
  for (const live of liveRulesets || []) {
    if (!(live.name in (desired || {}))) {
      // NEVER deleted by --fix (no --prune in v1) — but an undeclared live
      // ruleset is exactly the invisible-settings class #109 exists for.
      findings.push({ repo, kind: "ruleset-unmanaged", ruleset: live.name, id: live.id });
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
    for (const m of t.matchAll(/<!--\s*drift-fingerprint:\s*([0-9a-f]{64})\s*-->/g)) out.add(m[1]);
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
  if (f.kind === "ruleset-missing") return `ruleset \`${f.ruleset}\`: declared in the manifest, absent live`;
  if (f.kind === "ruleset-unmanaged") {
    return `ruleset \`${f.ruleset}\`: live but NOT in the manifest (unmanaged — declare it or delete it by hand; --fix never deletes)`;
  }
  // ruleset-drift
  return (
    `ruleset \`${f.ruleset}\` / ${f.facet}: live \`${JSON.stringify(f.live)}\` -> ` +
    `manifest \`${JSON.stringify(f.desired)}\``
  );
}

function describeInformational(f) {
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
  return `ruleset \`${f.ruleset}\` / rule ${f.rule}: live-only parameter \`${f.key}\` (informational)`;
}

// Grouped markdown findings: one section per repo.
function renderFindings(findings, informational) {
  const byRepo = new Map();
  for (const f of findings || []) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, { findings: [], informational: [] });
    byRepo.get(f.repo).findings.push(f);
  }
  for (const f of informational || []) {
    if (!byRepo.has(f.repo)) byRepo.set(f.repo, { findings: [], informational: [] });
    byRepo.get(f.repo).informational.push(f);
  }
  const lines = [];
  for (const [repo, group] of byRepo) {
    lines.push(`**${repo}**`);
    for (const f of group.findings) lines.push(`- ${describeFinding(f)}`);
    for (const f of group.informational) lines.push(`- _${describeInformational(f)}_`);
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
    "rulesets that no longer match `repo-settings.yml` (scanned at " + nowIso + ").",
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
  if (!doc || typeof doc !== "object") throw new Error(`${manifestPath}: empty/unparseable manifest`);
  if (doc.version !== 1) throw new Error(`${manifestPath}: unsupported version ${doc.version} (expected 1)`);
  if (!doc.repos || typeof doc.repos !== "object" || Object.keys(doc.repos).length === 0) {
    throw new Error(`${manifestPath}: no repos declared`);
  }
  const lib = doc.ruleset_library || {};
  for (const [repo, entry] of Object.entries(doc.repos)) {
    for (const key of Object.keys((entry && entry.settings) || {})) {
      if (!MANAGED_REPO_KEYS.includes(key)) {
        throw new Error(`${manifestPath}: repos.${repo}.settings.${key} is not a MANAGED_REPO_KEY`);
      }
    }
    for (const key of Object.keys((entry && entry.actions_permissions) || {})) {
      if (!MANAGED_ACTIONS_PERMISSION_KEYS.includes(key)) {
        throw new Error(
          `${manifestPath}: repos.${repo}.actions_permissions.${key} is not a MANAGED_ACTIONS_PERMISSION_KEY`,
        );
      }
    }
    for (const [name, libName] of Object.entries((entry && entry.rulesets) || {})) {
      if (!lib[libName]) {
        throw new Error(`${manifestPath}: repos.${repo}.rulesets.${name} references unknown ruleset_library entry "${libName}"`);
      }
    }
  }
  for (const key of Object.keys(doc.settings_defaults || {})) {
    if (!MANAGED_REPO_KEYS.includes(key)) {
      throw new Error(`${manifestPath}: settings_defaults.${key} is not a MANAGED_REPO_KEY`);
    }
  }
  for (const key of Object.keys(doc.actions_permissions_defaults || {})) {
    if (!MANAGED_ACTIONS_PERMISSION_KEYS.includes(key)) {
      throw new Error(
        `${manifestPath}: actions_permissions_defaults.${key} is not a MANAGED_ACTIONS_PERMISSION_KEY`,
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

// Fetch the live repo + FULL ruleset bodies. Fails LOUD-and-DISTINCT: a
// 403/404, or a response missing the admin-visible settings surface (a token
// without Administration: Read gets a repo object WITHOUT the merge-flag
// keys — silently comparing against undefined would report 17 bogus drifts),
// is an OPERATIONAL failure (exit 1, "the alerting layer is broken"), never
// drift.
function fetchLive(repo, token) {
  const liveRepo = JSON.parse(ghApi(`repos/${repo}`, { token }));
  if (typeof liveRepo.delete_branch_on_merge !== "boolean") {
    throw new Error(
      `repos/${repo} response has no settings surface (delete_branch_on_merge missing) — ` +
        `the token lacks "Administration: Read" on ${repo}`,
    );
  }
  const list = JSON.parse(ghApi(`repos/${repo}/rulesets?per_page=100`, { token }));
  const liveRulesets = [];
  for (const r of Array.isArray(list) ? list : []) {
    // Org-level rulesets can surface on an org repo's list; they are not this
    // repo's to manage (or PUT) — scope to Repository-sourced ones.
    if (r.source_type && r.source_type !== "Repository") continue;
    liveRulesets.push(JSON.parse(ghApi(`repos/${repo}/rulesets/${r.id}`, { token })));
  }
  return { liveRepo, liveRulesets, liveActionsPermissions: fetchActionsPermissions(repo, token) };
}

// The Actions-permissions surface (two standalone endpoints). Fails LOUD like
// fetchLive: a response to actions/permissions missing the admin-visible
// `enabled` boolean means the token lacks the Actions/Administration read
// surface (an OPERATIONAL failure, exit 1 — never silent drift against
// undefined). The fork-pr-contributor-approval endpoint returns HTTP 422 on a
// PRIVATE repo ("not allowed for private repositories"); that ONE case is an
// operational SKIP ({skipped:true}), distinguished from any other error which
// re-throws as an operational failure.
function fetchActionsPermissions(repo, token) {
  const permissions = JSON.parse(ghApi(`repos/${repo}/${ACTIONS_PERMISSIONS_ENDPOINT}`, { token }));
  if (typeof permissions.enabled !== "boolean") {
    throw new Error(
      `repos/${repo}/${ACTIONS_PERMISSIONS_ENDPOINT} response has no 'enabled' boolean — ` +
        `the token lacks "Administration: Read" (Actions permissions) on ${repo}`,
    );
  }
  let forkApproval;
  try {
    forkApproval = JSON.parse(ghApi(`repos/${repo}/${FORK_PR_APPROVAL_ENDPOINT}`, { token }));
  } catch (e) {
    const text = `${(e && e.stderr) || ""}${(e && e.message) || ""}`;
    if (/HTTP 422|not allowed for private repositor/i.test(text)) {
      forkApproval = {
        skipped: true,
        reason: "fork-pr-contributor-approval endpoint returns HTTP 422 on a private repo",
      };
    } else {
      throw e;
    }
  }
  return { permissions, forkApproval };
}

function findTrackingIssue(label) {
  const res = JSON.parse(
    ghApi(`repos/${ISSUE_REPO}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`),
  );
  return (
    (Array.isArray(res) ? res : []).find(
      (i) => !i.pull_request && typeof i.body === "string" && i.body.includes(MARKER),
    ) || null
  );
}

function listIssueComments(number) {
  const comments = [];
  for (let page = 1; page <= 10; page++) {
    const batch = JSON.parse(
      ghApi(`repos/${ISSUE_REPO}/issues/${number}/comments?per_page=100&page=${page}`),
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
    let live;
    try {
      live = fetchLive(repo, token);
    } catch (e) {
      const envName = tokenEnvName(owner);
      console.error(`repo-settings-audit: FAILED to read ${repo}: ${e.message}`);
      console.error(
        `  This is an OPERATIONAL failure (exit 1), not drift — the audit's read path is broken.\n` +
          `  Check the ${envName} secret/env var (expired? unminted? missing "Administration: Read-only"?)\n` +
          `  or the ambient gh auth. See skills/cms-platform-secrets/SKILL.md "Platform-repo secrets".`,
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
    results.push({ repo, ...diff, ...live });
  }
  return results;
}

function printReport(results) {
  for (const r of results) {
    const flags = r.findings.filter((f) => f.kind === "flag-drift");
    const actions = r.findings.filter((f) => f.kind === "actions-permission-drift");
    const rulesets = r.findings.filter(
      (f) => f.kind !== "flag-drift" && f.kind !== "actions-permission-drift",
    );
    if (r.findings.length === 0) {
      console.log(`== ${r.repo}: OK (flags + ${r.liveRulesets.length} ruleset(s) + actions permissions match)`);
    } else {
      console.log(
        `== ${r.repo}: DRIFT — ${flags.length} flag(s), ${actions.length} actions-permission(s), ${rulesets.length} ruleset finding(s)`,
      );
      for (const f of r.findings) console.log(`::error title=repo-settings drift::${r.repo}: ${describeFinding(f)}`);
    }
    for (const f of r.informational) console.log(`::notice title=repo-settings::${r.repo}: ${describeInformational(f)}`);
  }
}

function runIssueLifecycle({ findings, informational, label, dryRun, nowIso }) {
  let issue;
  try {
    issue = findTrackingIssue(label);
  } catch (e) {
    console.error(`repo-settings-audit: failed to look up the tracking issue: ${e.message}`);
    return 1;
  }
  if (findings.length === 0) {
    if (issue) {
      console.log(`::notice title=Repo settings::Clean scan — closing tracking issue #${issue.number}.`);
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
          console.error(`repo-settings-audit: failed to close issue #${issue.number}: ${e.message}`);
          return 1;
        }
      }
    }
    console.log("OK — live settings match repo-settings.yml on every scanned repo.");
    return 0;
  }

  // Drift: the ISSUE is the alert; this run stays green once it is filed.
  const summary = `${findings.length} drift finding(s) across ${new Set(findings.map((f) => f.repo)).size} repo(s)`;
  if (!issue) {
    console.log(`::notice title=Repo settings::${summary} — opening the tracking issue.`);
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
        console.log(`Opened tracking issue #${created.number}: ${created.html_url}`);
      } catch (e) {
        console.error(`repo-settings-audit: failed to open the tracking issue: ${e.message}`);
        return 1;
      }
    } else {
      console.log(`(dry-run) would open "${ISSUE_TITLE}" [${label}] with:\n${renderFindings(findings, informational)}`);
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
    console.error(`repo-settings-audit: failed to read issue #${issue.number}: ${e.message}`);
    return 1;
  }
  const fp = fingerprint(findings);
  if (reported.has(fp)) {
    console.log(`OK — ${summary}; fingerprint already reported on tracking issue #${issue.number}. Nothing new.`);
    return 0;
  }
  console.log(`::notice title=Repo settings::${summary} — fingerprint changed; commenting on issue #${issue.number}.`);
  if (!dryRun) {
    try {
      ghApi(`repos/${ISSUE_REPO}/issues/${issue.number}/comments`, {
        fields: [`body=${buildComment({ findings, informational, nowIso })}`],
      });
    } catch (e) {
      console.error(`repo-settings-audit: failed to comment on issue #${issue.number}: ${e.message}`);
      return 1;
    }
  } else {
    console.log(`(dry-run) would comment:\n${renderFindings(findings, informational)}`);
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
    const skipNames = new Set(r.informational.filter((i) => i.fixSkip).map((i) => i.ruleset));
    const driftedNames = new Set(
      r.findings.filter((f) => f.kind === "ruleset-drift").map((f) => f.ruleset),
    );
    const liveByName = new Map(r.liveRulesets.map((l) => [l.name, l]));
    const puts = [];
    const skipped = [];
    for (const name of driftedNames) {
      if (skipNames.has(name)) {
        skipped.push(name);
        continue;
      }
      puts.push({ name, id: liveByName.get(name).id, body: { name, ...desired[name] } });
    }
    const posts = r.findings
      .filter((f) => f.kind === "ruleset-missing")
      .map((f) => ({ name: f.ruleset, body: { name: f.ruleset, ...desired[f.ruleset] } }));
    const unmanaged = r.findings.filter((f) => f.kind === "ruleset-unmanaged").map((f) => f.ruleset);
    // Actions-permissions PUTs — a surface SEPARATE from the flag PATCH body.
    // sha_pinning_required ECHOES the live enabled/allowed_actions so the PUT
    // can never disable Actions or narrow the allowed-actions policy;
    // approval_policy PUTs only its own field.
    const livePerms = (r.liveActionsPermissions && r.liveActionsPermissions.permissions) || {};
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
    if (
      Object.keys(patchBody).length ||
      manualOnly.length ||
      puts.length ||
      posts.length ||
      skipped.length ||
      unmanaged.length ||
      actionsPuts.length
    ) {
      plan.push({ repo: r.repo, patchBody, manualOnly, puts, posts, skipped, unmanaged, actionsPuts });
    }
  }
  return plan;
}

function printFixPlan(plan) {
  if (plan.length === 0) {
    console.log("Fix plan: EMPTY — live settings already match the manifest. Nothing to apply.");
    return;
  }
  console.log("Fix plan (nothing applied without --yes):");
  for (const p of plan) {
    console.log(`== ${p.repo}`);
    for (const [key, value] of Object.entries(p.patchBody)) {
      console.log(`   PATCH repos/${p.repo}  ${key} -> ${JSON.stringify(value)}`);
    }
    for (const key of p.manualOnly) {
      console.log(`   MANUAL-ONLY key \`${key}\` drifted — --fix refuses to PATCH it; reconcile by hand.`);
    }
    for (const put of p.puts) {
      console.log(`   PUT repos/${p.repo}/rulesets/${put.id} ("${put.name}") with the manifest body:`);
      console.log(`     ${JSON.stringify(sortRuleset(put.body))}`);
    }
    for (const put of p.actionsPuts || []) {
      console.log(
        `   PUT ${put.endpoint}  ${put.key} -> ${JSON.stringify(put.body[put.key])}` +
          ` (full body: ${JSON.stringify(put.body)})`,
      );
    }
    for (const post of p.posts) {
      console.log(`   POST repos/${p.repo}/rulesets ("${post.name}") — declared but absent live:`);
      console.log(`     ${JSON.stringify(sortRuleset(post.body))}`);
    }
    for (const name of p.skipped) {
      console.log(
        `   SKIPPED ruleset "${name}" — its live body carries an unknown non-allowlisted field ` +
          `(a manifest-built PUT would drop it). Reconcile by hand or extend the manifest.`,
      );
    }
    for (const name of p.unmanaged) {
      console.log(`   UNMANAGED live ruleset "${name}" — --fix never deletes; declare it or delete it by hand.`);
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
  }
}

function applyWrite(endpoint, method, body) {
  const payload = JSON.stringify(body);
  try {
    ghApi(endpoint, { method, input: payload });
    console.log(`applied ${method} ${endpoint}`);
  } catch (e) {
    // 409/422 = the API rejected the payload (shape change, race). NEVER
    // delete+recreate — print exactly what failed and stop.
    console.error(`repo-settings-audit: ${method} ${endpoint} FAILED: ${e.message}`);
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
  const repos = filter.length ? allRepos.filter((r) => filter.includes(r)) : allRepos;
  if (filter.length && repos.length !== filter.length) {
    const unknown = filter.filter((r) => !allRepos.includes(r));
    console.error(`repo-settings-audit: --repo ${unknown.join(", ")} not declared in ${manifestPath}`);
    return 1;
  }

  let results;
  try {
    results = scanRepos(manifest, repos, fixMode);
  } catch (e) {
    if (!e.operational) console.error(`repo-settings-audit: scan failed: ${e.message}`);
    return 1;
  }

  const findings = results.flatMap((r) => r.findings);
  const informational = results.flatMap((r) => r.informational);

  if (flag("json")) {
    console.log(JSON.stringify({ repos, findings, informational, fingerprint: fingerprint(findings) }, null, 2));
  } else {
    printReport(results);
  }

  if (issueMode) {
    return runIssueLifecycle({ findings, informational, label, dryRun, nowIso });
  }

  if (fixMode) {
    const plan = buildFixPlan(manifest, results);
    printFixPlan(plan);
    if (plan.length === 0) return 0;
    if (!yes) {
      console.log("Plan-only (no --yes): exiting 2 with changes pending. Re-run with --yes to apply.");
      return 2;
    }
    try {
      applyFixPlan(plan);
    } catch (e) {
      if (!e.operational) console.error(`repo-settings-audit: apply failed: ${e.message}`);
      return 1;
    }
    // Re-audit: a PATCH silently ignoring a field (or a PUT normalizing one)
    // must not report success. Unfixables (manual-only keys, unmanaged or
    // fix-skipped rulesets) also keep this non-zero — honestly.
    let recheck;
    try {
      recheck = scanRepos(manifest, repos, fixMode);
    } catch (e) {
      if (!e.operational) console.error(`repo-settings-audit: re-audit failed: ${e.message}`);
      return 1;
    }
    const remaining = recheck.flatMap((r) => r.findings);
    if (remaining.length) {
      console.error(`repo-settings-audit: ${remaining.length} finding(s) PERSIST after apply:`);
      for (const f of remaining) console.error(`  ${f.repo}: ${describeFinding(f)}`);
      return 2;
    }
    console.log("Applied + re-audited: live settings now match repo-settings.yml.");
    return 0;
  }

  return findings.length ? 2 : 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MARKER,
  ISSUE_TITLE,
  ISSUE_REPO,
  MANAGED_REPO_KEYS,
  FIX_FORBIDDEN_KEYS,
  MANAGED_ACTIONS_PERMISSION_KEYS,
  ACTIONS_PERMISSIONS_ENDPOINT,
  FORK_PR_APPROVAL_ENDPOINT,
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
  desiredRulesets,
  sortRuleset,
  normalizeRuleset,
  diffRuleset,
  diffRepo,
  diffActionsPermissions,
  fingerprint,
  fingerprintBlock,
  extractReportedFingerprints,
  renderFindings,
  buildIssueBody,
  buildComment,
  buildCloseComment,
  buildFixPlan,
};
