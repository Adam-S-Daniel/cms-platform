// @lane: local — pure-Node unit tests of scripts/audit-repo-settings.js helpers
// against live-captured fixtures; no browser, no network.
// Platform-internal (reads ../scripts + the root repo-settings.yml + the
// e2e/fixtures/repo-settings fixtures by literal path) — registered in
// playwright.config.js PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
/*
 * REGRESSION GUARD for the repo-settings drift audit (#109). The fixtures
 * under e2e/fixtures/repo-settings/ are the REAL API responses captured
 * 2026-07-10 (gh api repos/<r> and .../rulesets/<id>; ruleset ids 17169281,
 * 13985217, 15756474, 17032014, 17032043) — so the anchor test locks the
 * shipped manifest to "zero drift against the live values as-found", and the
 * normalization tests lock the anti-flap rules that keep a daily audit from
 * crying wolf:
 *   - server-assigned keys / rule order / check order never count as drift;
 *   - jodidaniel's org-repo default dismissal_restriction is stripped (a
 *     NON-default value stays drift);
 *   - required_status_checks[].integration_id is allowlist-dropped;
 *   - live-only rule params are informational; unknown top-level ruleset
 *     fields are informational AND flag the ruleset fix-skip (the lossy-PUT
 *     guard);
 *   - the drift fingerprint is order-stable (persistent drift = ONE issue
 *     comment, the run-ids-dedupe analog).
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const SCRIPT_PATH = path.resolve(__dirname, "../scripts/audit-repo-settings.js");
const MANIFEST_PATH = path.resolve(__dirname, "../repo-settings.yml");
const FIXTURES_DIR = path.join(__dirname, "fixtures", "repo-settings");

function loadScript() {
  delete require.cache[SCRIPT_PATH];
  return require(SCRIPT_PATH);
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, name), "utf8"));
}

// repo -> its captured live fixtures.
const LIVE = {
  "Adam-S-Daniel/cms-platform": {
    repo: "cms-platform.repo.json",
    rulesets: ["cms-platform.ruleset-main.json"],
  },
  "Adam-S-Daniel/adamdaniel.ai": {
    repo: "adamdaniel.repo.json",
    rulesets: ["adamdaniel.ruleset-main.json", "adamdaniel.ruleset-feature.json"],
  },
  "jodidaniel/jodidaniel.com": {
    repo: "jodidaniel.repo.json",
    rulesets: ["jodidaniel.ruleset-main.json", "jodidaniel.ruleset-feature.json"],
  },
};

// repo -> its captured live Actions-permissions fixtures (GET
// actions/permissions + GET .../fork-pr-contributor-approval, 2026-07-13).
const LIVE_ACTIONS = {
  "Adam-S-Daniel/cms-platform": {
    permissions: "cms-platform.actions-permissions.json",
    fork: "cms-platform.fork-pr-approval.json",
  },
  "Adam-S-Daniel/adamdaniel.ai": {
    permissions: "adamdaniel.actions-permissions.json",
    fork: "adamdaniel.fork-pr-approval.json",
  },
  "jodidaniel/jodidaniel.com": {
    permissions: "jodidaniel.actions-permissions.json",
    fork: "jodidaniel.fork-pr-approval.json",
  },
};

// Build the fetchLive-shaped { permissions, forkApproval } bundle from the
// captures; `mutate.permissions` / `mutate.forkApproval` override for the
// negative cases (e.g. a {skipped:true} private-repo fork endpoint).
function liveActions(repo, mutate = {}) {
  const m = LIVE_ACTIONS[repo];
  return {
    permissions: { ...fixture(m.permissions), ...(mutate.permissions || {}) },
    forkApproval: mutate.forkApproval || fixture(m.fork),
  };
}

function diffAgainstFixtures(script, manifest, repo, mutate = {}) {
  const live = LIVE[repo];
  const liveRepo = { ...fixture(live.repo), ...(mutate.repo || {}) };
  const liveRulesets = (mutate.rulesets || live.rulesets.map(fixture)).map((r) =>
    JSON.parse(JSON.stringify(r)),
  );
  return {
    repo,
    ...script.diffRepo({
      repo,
      desiredSettings: script.effectiveSettings(manifest, repo),
      desiredRulesets: script.desiredRulesets(manifest, repo),
      liveRepo,
      liveRulesets,
    }),
    liveRepo,
    liveRulesets,
  };
}

test.describe("audit-repo-settings.js — pure helpers vs live-captured fixtures", () => {
  test("importing never runs the CLI (require.main guard)", () => {
    // Would exec gh / process.exit if the CLI ran (no gh auth in the lint lane).
    expect(() => loadScript()).not.toThrow();
  });

  test("per-owner read-token env names (owner slug: non-alnum -> _)", () => {
    const { ownerSlug, tokenEnvName } = loadScript();
    expect(ownerSlug("Adam-S-Daniel")).toBe("ADAM_S_DANIEL");
    expect(ownerSlug("jodidaniel")).toBe("JODIDANIEL");
    expect(tokenEnvName("Adam-S-Daniel")).toBe("REPO_SETTINGS_READ_ADAM_S_DANIEL");
    expect(tokenEnvName("jodidaniel")).toBe("REPO_SETTINGS_READ_JODIDANIEL");
  });

  test("ANCHOR: the shipped manifest is ZERO-drift against the as-found live captures", () => {
    // The v1 manifest encodes today's live values verbatim (including the
    // platform's delete_branch_on_merge:false and jodidaniel's DRIFTED main
    // ruleset) so the mechanism PR changes no behavior. If this fails, either
    // the manifest or the normalization regressed — NOT the live repos.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    for (const repo of Object.keys(LIVE)) {
      const { findings, informational } = diffAgainstFixtures(script, manifest, repo);
      expect(findings, `${repo}: expected zero drift, got ${JSON.stringify(findings)}`).toEqual([]);
      expect(
        informational,
        `${repo}: expected zero informational lines (anti-flap normalization ` +
          `should absorb ALL live noise), got ${JSON.stringify(informational)}`,
      ).toEqual([]);
    }
  });

  test("(a) jodidaniel feature ruleset vs the SHARED library entry is clean (default dismissal_restriction stripped)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("jodidaniel.ruleset-feature.json");
    // The org-repo-only decoration is present in the capture...
    const pr = live.rules.find((r) => r.type === "pull_request");
    expect(pr.parameters.dismissal_restriction).toEqual({ enabled: false, allowed_actors: [] });
    // ...and both consumers resolve the SAME library entry cleanly.
    const { projected, unknownKeys } = script.normalizeRuleset(live);
    expect(unknownKeys).toEqual([]);
    const desired = script.sortRuleset({
      name: "cms-feature-branches",
      ...manifest.ruleset_library["cms-feature-branches"],
    });
    const findings = [];
    const informational = [];
    script.diffRuleset("jodidaniel/jodidaniel.com", "cms-feature-branches", projected, desired, findings, informational);
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });

  test("(b) rule order / check order / server keys never count as drift", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const shuffled = fixture("adamdaniel.ruleset-main.json");
    shuffled.rules.reverse();
    const rsc = shuffled.rules.find((r) => r.type === "required_status_checks");
    rsc.parameters.required_status_checks.reverse();
    shuffled.updated_at = "2099-01-01T00:00:00Z"; // server keys are stripped
    shuffled.current_user_can_bypass = "always";
    const { findings, informational } = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/adamdaniel.ai", {
      rulesets: [shuffled, fixture("adamdaniel.ruleset-feature.json")],
    });
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });

  test("(c) a delete_branch_on_merge flip IS detected (the motivating incident)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const { findings } = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/cms-platform", {
      repo: { delete_branch_on_merge: true }, // manifest says false (as-found)
    });
    expect(findings).toEqual([
      {
        repo: "Adam-S-Daniel/cms-platform",
        kind: "flag-drift",
        key: "delete_branch_on_merge",
        live: true,
        desired: false,
        manualOnly: false,
      },
    ]);
  });

  test("(d) jodidaniel main vs consumer-main = EXACTLY the 3 known skew findings", () => {
    // The live consumer skew #109 complains about: missing
    // required_status_checks, missing non_fast_forward, admin bypass. This is
    // what phase 2 will surface when the DRIFTED entry is deleted.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const { projected } = script.normalizeRuleset(fixture("jodidaniel.ruleset-main.json"));
    const desired = script.sortRuleset({ name: "main", ...manifest.ruleset_library["consumer-main"] });
    const findings = [];
    const informational = [];
    script.diffRuleset("jodidaniel/jodidaniel.com", "main", projected, desired, findings, informational);
    expect(findings.map((f) => f.facet).sort()).toEqual([
      "bypass_actors",
      "rule:non_fast_forward",
      "rule:required_status_checks",
    ]);
    expect(findings.length).toBe(3);
  });

  test("(e) an unmanaged live ruleset is detected (and never auto-deleted)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const stray = fixture("adamdaniel.ruleset-feature.json"); // not declared for the platform repo
    const { findings, liveRepo, liveRulesets } = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/cms-platform",
      { rulesets: [fixture("cms-platform.ruleset-main.json"), stray] },
    );
    expect(findings).toEqual([
      {
        repo: "Adam-S-Daniel/cms-platform",
        kind: "ruleset-unmanaged",
        ruleset: "cms-feature-branches",
        id: stray.id,
      },
    ]);
    // ...and --fix's plan only ever REPORTS it — no delete call is planned.
    const plan = script.buildFixPlan(manifest, [
      { repo: "Adam-S-Daniel/cms-platform", findings, informational: [], liveRepo, liveRulesets },
    ]);
    expect(plan[0].unmanaged).toEqual(["cms-feature-branches"]);
    expect(plan[0].puts).toEqual([]);
    expect(plan[0].posts).toEqual([]);
  });

  test("(f) a live-only rule-parameter key is INFORMATIONAL, not drift", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("adamdaniel.ruleset-main.json");
    live.rules.find((r) => r.type === "pull_request").parameters.some_future_param = 7;
    const { findings, informational } = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/adamdaniel.ai", {
      rulesets: [live, fixture("adamdaniel.ruleset-feature.json")],
    });
    expect(findings).toEqual([]);
    expect(informational).toEqual([
      {
        repo: "Adam-S-Daniel/adamdaniel.ai",
        kind: "rule-param-extra",
        ruleset: "main",
        rule: "pull_request",
        key: "some_future_param",
        fixSkip: true,
      },
    ]);
  });

  test("a NON-default dismissal_restriction is drift (only the default is noise)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("jodidaniel.ruleset-main.json");
    live.rules.find((r) => r.type === "pull_request").parameters.dismissal_restriction = {
      enabled: true,
      allowed_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }],
    };
    const { findings } = diffAgainstFixtures(script, manifest, "jodidaniel/jodidaniel.com", {
      rulesets: [live, fixture("jodidaniel.ruleset-feature.json")],
    });
    expect(findings.map((f) => f.facet)).toEqual(["rule:pull_request.dismissal_restriction"]);
  });

  test("(g) the drift fingerprint is order-stable and change-sensitive", () => {
    const { fingerprint } = loadScript();
    const f1 = { repo: "o/r", kind: "flag-drift", key: "has_wiki", live: true, desired: false };
    const f2 = { repo: "o/r", kind: "ruleset-unmanaged", ruleset: "stray" };
    expect(fingerprint([f1, f2])).toBe(fingerprint([f2, f1]));
    expect(fingerprint([f1, f2])).not.toBe(fingerprint([f1]));
    expect(fingerprint([f1])).not.toBe(fingerprint([{ ...f1, live: false, desired: true }]));
    expect(fingerprint([])).toBe(fingerprint([]));
  });

  test("(h) an unknown non-allowlisted ruleset field -> ruleset-unknown-field + fix-skip (the lossy-PUT guard)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("cms-platform.ruleset-main.json");
    live.push_allowances = ["something-the-api-grew"]; // unknown top-level field
    live.enforcement = "disabled"; // AND a real drift on the same ruleset
    const scan = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/cms-platform", {
      rulesets: [live],
    });
    expect(scan.informational).toEqual([
      {
        repo: "Adam-S-Daniel/cms-platform",
        kind: "ruleset-unknown-field",
        ruleset: "main",
        key: "push_allowances",
        fixSkip: true,
      },
    ]);
    expect(scan.findings.map((f) => f.facet)).toEqual(["enforcement"]);
    // --fix must SKIP the ruleset: a manifest-built PUT would drop the field.
    const plan = script.buildFixPlan(manifest, [scan]);
    expect(plan[0].skipped).toEqual(["main"]);
    expect(plan[0].puts).toEqual([]);
  });

  test("buildFixPlan: drifted keys only, manual-only keys refused, PUT carries the full library body", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const scan = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/cms-platform", {
      repo: { delete_branch_on_merge: true, default_branch: "master" },
      rulesets: [{ ...fixture("cms-platform.ruleset-main.json"), enforcement: "evaluate" }],
    });
    const plan = script.buildFixPlan(manifest, [scan]);
    expect(plan.length).toBe(1);
    // Only the drifted, non-forbidden key is PATCHed — never the full flag set.
    expect(plan[0].patchBody).toEqual({ delete_branch_on_merge: false });
    // default_branch drift is audited but NEVER PATCHed (FIX_FORBIDDEN_KEYS).
    expect(script.FIX_FORBIDDEN_KEYS).toContain("default_branch");
    expect(plan[0].manualOnly).toEqual(["default_branch"]);
    // The drifted ruleset is PUT by live id with the full manifest body.
    expect(plan[0].puts.length).toBe(1);
    expect(plan[0].puts[0].id).toBe(17169281);
    expect(plan[0].puts[0].body.name).toBe("main");
    expect(plan[0].puts[0].body.enforcement).toBe("active");
    expect(plan[0].puts[0].body.rules.length).toBe(4);
  });

  test("buildFixPlan is EMPTY on a clean scan (the --fix plan-mode proof)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const results = Object.keys(LIVE).map((repo) => diffAgainstFixtures(script, manifest, repo));
    expect(script.buildFixPlan(manifest, results)).toEqual([]);
  });

  test("issue plumbing: stable marker, fingerprint block roundtrip, ratify-or-revert playbook", () => {
    const script = loadScript();
    const findings = [
      { repo: "o/r", kind: "flag-drift", key: "has_wiki", live: true, desired: false, manualOnly: false },
    ];
    expect(script.MARKER).toBe("<!-- repo-settings-drift-audit -->");
    const body = script.buildIssueBody({ findings, informational: [], nowIso: "2026-07-11T00:00:00Z" });
    expect(body.startsWith(script.MARKER)).toBe(true);
    expect(script.extractReportedFingerprints([body]).has(script.fingerprint(findings))).toBe(true);
    expect(body).toMatch(/RATIFY/);
    expect(body).toMatch(/REVERT/);
    expect(body).toMatch(/--fix/);
    const comment = script.buildComment({ findings, informational: [], nowIso: "2026-07-11T00:00:00Z" });
    expect(script.extractReportedFingerprints([comment]).has(script.fingerprint(findings))).toBe(true);
    // A hand-edited comment without a block never poisons the dedupe.
    expect(script.extractReportedFingerprints(["no block here", null]).size).toBe(0);
  });

  test("CLI refuses --issue + --repo (a clean subset must never auto-close the global alert)", () => {
    // runIssueLifecycle treats findings.length===0 as a GLOBALLY-clean scan and
    // closes the tracking issue; scoping the scan with --repo would let a clean
    // subset retire the alert while another managed repo is still drifted. The
    // guard fires on args alone — before any manifest load / gh call — so this
    // asserts exit!=0 + the precise message with no network.
    const res = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "--issue", "--repo", "Adam-S-Daniel/cms-platform"],
      { encoding: "utf8" },
    );
    expect(res.status, `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`).not.toBe(0);
    expect(res.stderr).toMatch(/--issue audits ALL managed repos/);
    expect(res.stderr).toMatch(/drop --repo/);
  });

  // ── Actions-permissions surface (#109 extension) ──────────────────────────
  // A THIRD managed surface (two standalone GET/PUT endpoints, NOT
  // repos/{owner}/{repo}) — sha_pinning_required + fork-PR approval_policy.
  // Unlike the flags/rulesets ANCHOR, the desired baseline INTENTIONALLY
  // differs from the 2026-07-13 captures: enforcing it is the whole point, so
  // these tests lock the EXACT as-found drift a `--fix` will correct.
  test("(i) actions permissions drift EXACTLY to the desired baseline on every repo", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    // cms-platform: sha_pinning false->true AND fork first_time->all_external.
    // consumers: sha already true, only the fork policy drifts.
    const expectByRepo = {
      "Adam-S-Daniel/cms-platform": ["approval_policy", "sha_pinning_required"],
      "Adam-S-Daniel/adamdaniel.ai": ["approval_policy"],
      "jodidaniel/jodidaniel.com": ["approval_policy"],
    };
    for (const repo of Object.keys(LIVE_ACTIONS)) {
      const findings = [];
      const informational = [];
      script.diffActionsPermissions(
        repo,
        script.effectiveActionsPermissions(manifest, repo),
        liveActions(repo),
        findings,
        informational,
      );
      expect(findings.map((f) => f.key).sort(), `${repo}: ${JSON.stringify(findings)}`).toEqual(
        expectByRepo[repo],
      );
      expect(findings.every((f) => f.kind === "actions-permission-drift")).toBe(true);
      expect(informational).toEqual([]);
    }
  });

  test("(j) sha_pinning_required drift is endpoint-tagged (the actions/permissions surface)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    script.diffActionsPermissions(
      repo,
      script.effectiveActionsPermissions(manifest, repo),
      liveActions(repo),
      findings,
      [],
    );
    expect(findings.find((f) => f.key === "sha_pinning_required")).toEqual({
      repo,
      kind: "actions-permission-drift",
      key: "sha_pinning_required",
      endpoint: "actions/permissions",
      live: false,
      desired: true,
    });
    expect(findings.find((f) => f.key === "approval_policy").endpoint).toBe(
      "actions/permissions/fork-pr-contributor-approval",
    );
  });

  test("(k) a private-repo fork-approval 422 is an operational SKIP, never drift", () => {
    // GUARD: the fork endpoint 422s on a PRIVATE repo. fetchLive marks it
    // {skipped:true}; the diff must emit an informational line and NO
    // approval_policy finding, while sha_pinning_required still diffs normally.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/adamdaniel.ai";
    const live = liveActions(repo, {
      permissions: { sha_pinning_required: false }, // force a sha drift too
      forkApproval: { skipped: true, reason: "private-repo 422" },
    });
    const findings = [];
    const informational = [];
    script.diffActionsPermissions(
      repo,
      script.effectiveActionsPermissions(manifest, repo),
      live,
      findings,
      informational,
    );
    expect(findings.map((f) => f.key)).toEqual(["sha_pinning_required"]);
    expect(informational).toEqual([
      {
        repo,
        kind: "actions-permission-skipped",
        key: "approval_policy",
        endpoint: "actions/permissions/fork-pr-contributor-approval",
        reason: "private-repo 422",
        fixSkip: true,
      },
    ]);
  });

  test("(l) buildFixPlan: sha PUT ECHOES enabled+allowed_actions; fork PUT sets approval_policy", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const liveAP = liveActions(repo); // sha:false, fork:first_time_contributors
    const findings = [];
    const informational = [];
    script.diffActionsPermissions(
      repo,
      script.effectiveActionsPermissions(manifest, repo),
      liveAP,
      findings,
      informational,
    );
    const plan = script.buildFixPlan(manifest, [
      {
        repo,
        findings,
        informational,
        liveRepo: fixture("cms-platform.repo.json"),
        liveRulesets: [fixture("cms-platform.ruleset-main.json")],
        liveActionsPermissions: liveAP,
      },
    ]);
    expect(plan.length).toBe(1);
    // Actions PUTs never leak into the flag PATCH body (separate surface).
    expect(plan[0].patchBody).toEqual({});
    const sha = plan[0].actionsPuts.find((p) => p.key === "sha_pinning_required");
    expect(sha.endpoint).toBe("repos/Adam-S-Daniel/cms-platform/actions/permissions");
    // The live enabled + allowed_actions are echoed back so the PUT can't
    // disable Actions or narrow the allowed-actions policy.
    expect(sha.body).toEqual({
      enabled: true,
      allowed_actions: "all",
      sha_pinning_required: true,
    });
    const fork = plan[0].actionsPuts.find((p) => p.key === "approval_policy");
    expect(fork.endpoint).toBe(
      "repos/Adam-S-Daniel/cms-platform/actions/permissions/fork-pr-contributor-approval",
    );
    expect(fork.body).toEqual({ approval_policy: "all_external_contributors" });
  });

  test("(m) a repo already at the desired actions baseline yields NO actions findings", () => {
    // Prove the diff is genuinely two-sided: feed live values that equal the
    // manifest and expect zero drift (the anti-false-positive proof).
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/adamdaniel.ai";
    const live = liveActions(repo, {
      permissions: { sha_pinning_required: true },
      forkApproval: { approval_policy: "all_external_contributors" },
    });
    const findings = [];
    const informational = [];
    script.diffActionsPermissions(
      repo,
      script.effectiveActionsPermissions(manifest, repo),
      live,
      findings,
      informational,
    );
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });
});
