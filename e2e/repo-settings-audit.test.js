// @lane: local — pure-Node unit tests of scripts/audit-repo-settings.js helpers
// against live-captured fixtures; no browser, no network.
// Platform-internal (reads ../scripts + the root repo-settings.yml + the
// e2e/fixtures/repo-settings fixtures by literal path) — registered in
// playwright.config.js PLATFORM_META_SPECS and testIgnore'd on consumer lanes.
/*
 * REGRESSION GUARD for the repo-settings drift audit (#109). The fixtures
 * under e2e/fixtures/repo-settings/ are REAL API responses captured
 * 2026-07-10 (gh api repos/<r> and .../rulesets/<id>; ruleset ids 17169281,
 * 13985217, 15756474, 17032014, 17032043) — EXCEPT cms-platform.repo.json
 * (delete_branch_on_merge flipped true), BOTH consumers'
 * *.ruleset-feature.json (the #371 required-context spelling flipped from the
 * unpublishable `validate-content` to `editorial / validate-content`; the
 * as-found captures moved to *.ruleset-feature.DRIFTED-as-found-2026-07-10.json
 * — see test (g)) and jodidaniel.ruleset-main.json
 * (now the phase-2 CONVERGED shape onto consumer-main; the as-found capture
 * moved to jodidaniel.ruleset-main.DRIFTED-as-found-2026-07-10.json), both
 * updated 2026-07-22 for #172 phase 2, and cms-platform.ruleset-main.json
 * (the `plugin-validate` required context added in v0.1.83 — the manifest
 * declares it and this fixture encodes that desired state, so live stays
 * BEHIND until a human runs `--fix --yes`; same manifest-ahead-of-live shape
 * as the delete_branch_on_merge flip above), and BOTH consumers'
 * *.ruleset-main.json again on 2026-09-01 (the `site-verify / site-verify`
 * required context, #377 sequencing step 3 — added only after both consumers
 * published it on their v0.1.98 bump PRs; same manifest-ahead-of-live shape
 * until the next reconcile). So the anchor test locks the shipped
 * manifest to "zero drift against the phase-2 desired-converged fixtures",
 * and the normalization tests lock the anti-flap rules that keep a daily
 * audit from crying wolf:
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
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const SCRIPT_PATH = path.resolve(
  __dirname,
  "../scripts/audit-repo-settings.js",
);
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
    rulesets: [
      "adamdaniel.ruleset-main.json",
      "adamdaniel.ruleset-feature.json",
    ],
  },
  "jodidaniel/jodidaniel.com": {
    repo: "jodidaniel.repo.json",
    rulesets: [
      "jodidaniel.ruleset-main.json",
      "jodidaniel.ruleset-feature.json",
    ],
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

// The repo MERGE-SETTING keys GitHub gates behind the CONTENTS permission
// (read+write) — ENTIRELY ABSENT from the repo object a correctly read-only
// Administration:Read PAT returns (verified empirically). The degraded-path
// tests remove exactly these to simulate a CI read token.
const CONTENTS_GATED_KEYS = [
  "delete_branch_on_merge",
  "allow_squash_merge",
  "allow_merge_commit",
  "allow_rebase_merge",
  "allow_auto_merge",
  "allow_update_branch",
  "use_squash_pr_title_as_default",
  "squash_merge_commit_title",
  "squash_merge_commit_message",
  "merge_commit_title",
  "merge_commit_message",
];

// A fake `ghApi(endpoint, opts)` for the fetch-PATH tests (fetchLive /
// fetchActionsPermissions take an injectable `api`, defaulting to the real
// gh-backed one). `routes` maps an EXACT endpoint string to a JS value
// (JSON-stringified back, mirroring gh's stdout) or to a function that THROWS
// an Error whose .message/.stderr mimic a gh 403/422 failure.
function fakeApi(routes) {
  return (endpoint) => {
    if (!(endpoint in routes))
      throw new Error(`fakeApi: unrouted endpoint ${endpoint}`);
    const resp = routes[endpoint];
    if (typeof resp === "function") return resp(); // negative cases throw here
    return JSON.stringify(resp);
  };
}

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
  const liveRulesets = (mutate.rulesets || live.rulesets.map(fixture)).map(
    (r) => JSON.parse(JSON.stringify(r)),
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
    expect(tokenEnvName("Adam-S-Daniel")).toBe(
      "REPO_SETTINGS_READ_ADAM_S_DANIEL",
    );
    expect(tokenEnvName("jodidaniel")).toBe("REPO_SETTINGS_READ_JODIDANIEL");
  });

  test("ANCHOR: the shipped manifest is ZERO-drift against the fixtures (2026-07-22 phase-2 desired state)", () => {
    // As of #172 phase 2 (2026-07-22) the manifest + fixtures encode the
    // DESIRED CONVERGED state, not a pure as-found capture: the platform's
    // delete_branch_on_merge is now true (fixture flipped to match) and
    // jodidaniel's main ruleset fixture is now the consumer-main-shaped
    // converged body (the as-found DRIFTED capture lives on under
    // jodidaniel.ruleset-main.DRIFTED-as-found-2026-07-10.json — see test (d)).
    // If this fails, either the manifest or the fixtures/normalization
    // regressed — NOT the live repos (this is a fixture-vs-manifest lock,
    // not a live comparison).
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    for (const repo of Object.keys(LIVE)) {
      const { findings, informational } = diffAgainstFixtures(
        script,
        manifest,
        repo,
      );
      expect(
        findings,
        `${repo}: expected zero drift, got ${JSON.stringify(findings)}`,
      ).toEqual([]);
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
    expect(pr.parameters.dismissal_restriction).toEqual({
      enabled: false,
      allowed_actors: [],
    });
    // ...and both consumers resolve the SAME library entry cleanly.
    const { projected, unknownKeys } = script.normalizeRuleset(live);
    expect(unknownKeys).toEqual([]);
    const desired = script.sortRuleset({
      name: "cms-feature-branches",
      ...manifest.ruleset_library["cms-feature-branches"],
    });
    const findings = [];
    const informational = [];
    script.diffRuleset(
      "jodidaniel/jodidaniel.com",
      "cms-feature-branches",
      projected,
      desired,
      findings,
      informational,
    );
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
    const { findings, informational } = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/adamdaniel.ai",
      {
        rulesets: [shuffled, fixture("adamdaniel.ruleset-feature.json")],
      },
    );
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });

  test("(c) a delete_branch_on_merge flip IS detected (the motivating incident)", () => {
    // Since #172 phase 2 (2026-07-22) the manifest desires true (the fleet
    // default the platform repo now inherits, having dropped its false
    // override) — so the flip this test locks is a live regression BACK to
    // false, not the other direction.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const { findings } = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/cms-platform",
      {
        repo: { delete_branch_on_merge: false }, // manifest says true (phase-2 desired)
      },
    );
    expect(findings).toEqual([
      {
        repo: "Adam-S-Daniel/cms-platform",
        kind: "flag-drift",
        key: "delete_branch_on_merge",
        live: false,
        desired: true,
        manualOnly: false,
      },
    ]);
  });

  test("(d) jodidaniel main vs consumer-main = EXACTLY the 5 known skew findings", () => {
    // The historical drift corpus locking the skew detection: missing
    // required_status_checks, missing non_fast_forward, admin bypass. #172
    // phase 2 (2026-07-22) converged jodidaniel main onto consumer-main and
    // deleted the DRIFTED library entry, but this test still diffs the
    // AS-FOUND capture (now DRIFTED-as-found-2026-07-10.json) against the
    // surviving manifest.ruleset_library["consumer-main"] entry, so the
    // regression lock stands unchanged.
    //
    // `rule:pull_request` is the FOURTH, and it is the corpus doing its job
    // rather than a regression: the 2026-07-10 capture predates dropping
    // `rebase` from consumer-main's allowed_merge_methods, so a fixture frozen
    // before that change genuinely carries one more skew than it used to. The
    // as-found file is deliberately NOT re-captured — an as-found corpus that
    // gets edited every time desired state moves stops being evidence.
    //
    // `…require_extra_approval_for_unattributed_changes` is the FIFTH, by that
    // same rule (#313). GitHub added that pull_request parameter after this
    // capture was taken, and it is now `true` live on all five rulesets across
    // all three repos (measured 2026-08-27), so the manifest declares it —
    // leaving it UNDECLARED is what made every PUT lossy and got the `main`
    // ruleset fix-skipped for eleven days. A fixture frozen before GitHub
    // shipped the parameter cannot carry it, so the skew count goes up by one.
    // The CURRENT fixtures were re-captured for that field; this one was not.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const { projected } = script.normalizeRuleset(
      fixture("jodidaniel.ruleset-main.DRIFTED-as-found-2026-07-10.json"),
    );
    const desired = script.sortRuleset({
      name: "main",
      ...manifest.ruleset_library["consumer-main"],
    });
    const findings = [];
    const informational = [];
    script.diffRuleset(
      "jodidaniel/jodidaniel.com",
      "main",
      projected,
      desired,
      findings,
      informational,
    );
    expect(findings.map((f) => f.facet).sort()).toEqual([
      "bypass_actors",
      "rule:non_fast_forward",
      "rule:pull_request.allowed_merge_methods",
      "rule:pull_request.require_extra_approval_for_unattributed_changes",
      "rule:required_status_checks",
    ]);
    expect(findings.length).toBe(5);
  });

  // #371. The as-found captures are the EVIDENCE that the defect was live on
  // both consumers, not merely latent in the manifest — so they are kept, and
  // diffed, rather than quietly overwritten. Same rule as (d): an as-found
  // corpus that gets edited every time desired state moves stops being
  // evidence.
  //
  // What they show: `cms-feature-branches` required the context
  // `validate-content`, which nothing publishes. A consumer's thin caller
  // declares job id `editorial` and `uses:` the platform reusable whose job id
  // is `validate-content`, so the check run GitHub actually reports is
  // `editorial / validate-content`. A required context that never reports never
  // goes green and a branch ruleset does not time out, so every PR onto
  // `cms/**`, `claude/**`, `feat/**`, … was permanently `mergeable_state:
  // blocked` — which is why an editor publishing from a PR-preview admin (whose
  // editorial PR is based on exactly those refs) got every success signal and
  // no merge, ever. Measured on jodidaniel.com#233.
  //
  // Only an admin's `bypass_actors` entry ever moved one, which is why it went
  // unnoticed: the people who could merge never met the wall.
  test("(g) the as-found feature rulesets carry EXACTLY the #371 required-context skew", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    for (const [repo, file] of [
      ["Adam-S-Daniel/adamdaniel.ai", "adamdaniel.ruleset-feature.DRIFTED-as-found-2026-07-10.json"],
      ["jodidaniel/jodidaniel.com", "jodidaniel.ruleset-feature.DRIFTED-as-found-2026-07-10.json"],
    ]) {
      const asFound = fixture(file);
      expect(
        asFound.rules.find((r) => r.type === "required_status_checks").parameters
          .required_status_checks,
        `${file} must preserve the unpublishable context as captured`,
      ).toEqual([{ context: "validate-content" }]);

      const { projected } = script.normalizeRuleset(asFound);
      const desired = script.sortRuleset({
        name: "cms-feature-branches",
        ...manifest.ruleset_library["cms-feature-branches"],
      });
      const findings = [];
      const informational = [];
      script.diffRuleset(repo, "cms-feature-branches", projected, desired, findings, informational);
      expect(
        findings.map((f) => f.facet),
        `${repo}: the as-found capture must differ from the fixed manifest in exactly one facet`,
      ).toEqual(["rule:required_status_checks.required_status_checks"]);
    }
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
      {
        repo: "Adam-S-Daniel/cms-platform",
        findings,
        informational: [],
        liveRepo,
        liveRulesets,
      },
    ]);
    expect(plan[0].unmanaged).toEqual(["cms-feature-branches"]);
    expect(plan[0].puts).toEqual([]);
    expect(plan[0].posts).toEqual([]);
  });

  test("(f) a live-only rule-parameter key is INFORMATIONAL, not drift", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("adamdaniel.ruleset-main.json");
    live.rules.find(
      (r) => r.type === "pull_request",
    ).parameters.some_future_param = 7;
    const { findings, informational } = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/adamdaniel.ai",
      {
        rulesets: [live, fixture("adamdaniel.ruleset-feature.json")],
      },
    );
    expect(findings).toEqual([]);
    expect(informational).toEqual([
      {
        repo: "Adam-S-Daniel/adamdaniel.ai",
        kind: "rule-param-extra",
        ruleset: "main",
        rule: "pull_request",
        key: "some_future_param",
        // #313: the VALUE rides along. Naming only the KEY is what forced a
        // hand-read of the live ruleset to find out whether the undeclared
        // parameter was a real protection or GitHub's inert default.
        value: 7,
        fixSkip: true,
      },
    ]);
  });

  test("a NON-default dismissal_restriction is drift (only the default is noise)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("jodidaniel.ruleset-main.json");
    live.rules.find(
      (r) => r.type === "pull_request",
    ).parameters.dismissal_restriction = {
      enabled: true,
      allowed_actors: [{ actor_id: 5, actor_type: "RepositoryRole" }],
    };
    const { findings } = diffAgainstFixtures(
      script,
      manifest,
      "jodidaniel/jodidaniel.com",
      {
        rulesets: [live, fixture("jodidaniel.ruleset-feature.json")],
      },
    );
    expect(findings.map((f) => f.facet)).toEqual([
      "rule:pull_request.dismissal_restriction",
    ]);
  });

  test("(g) the drift fingerprint is order-stable and change-sensitive", () => {
    const { fingerprint } = loadScript();
    const f1 = {
      repo: "o/r",
      kind: "flag-drift",
      key: "has_wiki",
      live: true,
      desired: false,
    };
    const f2 = { repo: "o/r", kind: "ruleset-unmanaged", ruleset: "stray" };
    expect(fingerprint([f1, f2])).toBe(fingerprint([f2, f1]));
    expect(fingerprint([f1, f2])).not.toBe(fingerprint([f1]));
    expect(fingerprint([f1])).not.toBe(
      fingerprint([{ ...f1, live: false, desired: true }]),
    );
    expect(fingerprint([])).toBe(fingerprint([]));
  });

  test("(h) an unknown non-allowlisted ruleset field -> ruleset-unknown-field + fix-skip (the lossy-PUT guard)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = fixture("cms-platform.ruleset-main.json");
    live.push_allowances = ["something-the-api-grew"]; // unknown top-level field
    live.enforcement = "disabled"; // AND a real drift on the same ruleset
    const scan = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/cms-platform",
      {
        rulesets: [live],
      },
    );
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
    const scan = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/cms-platform",
      {
        // manifest desires true (phase-2 converged) — mutate live to false so
        // this still exercises a real delete_branch_on_merge drift.
        repo: { delete_branch_on_merge: false, default_branch: "master" },
        rulesets: [
          {
            ...fixture("cms-platform.ruleset-main.json"),
            enforcement: "evaluate",
          },
        ],
      },
    );
    const plan = script.buildFixPlan(manifest, [scan]);
    expect(plan.length).toBe(1);
    // Only the drifted, non-forbidden key is PATCHed — never the full flag set.
    expect(plan[0].patchBody).toEqual({ delete_branch_on_merge: true });
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
    const results = Object.keys(LIVE).map((repo) =>
      diffAgainstFixtures(script, manifest, repo),
    );
    expect(script.buildFixPlan(manifest, results)).toEqual([]);
  });

  test("issue plumbing: stable marker, fingerprint block roundtrip, ratify-or-revert playbook", () => {
    const script = loadScript();
    const findings = [
      {
        repo: "o/r",
        kind: "flag-drift",
        key: "has_wiki",
        live: true,
        desired: false,
        manualOnly: false,
      },
    ];
    expect(script.MARKER).toBe("<!-- repo-settings-drift-audit -->");
    const body = script.buildIssueBody({
      findings,
      informational: [],
      nowIso: "2026-07-11T00:00:00Z",
    });
    expect(body.startsWith(script.MARKER)).toBe(true);
    expect(
      script
        .extractReportedFingerprints([body])
        .has(script.fingerprint(findings)),
    ).toBe(true);
    expect(body).toMatch(/RATIFY/);
    expect(body).toMatch(/REVERT/);
    expect(body).toMatch(/--fix/);
    const comment = script.buildComment({
      findings,
      informational: [],
      nowIso: "2026-07-11T00:00:00Z",
    });
    expect(
      script
        .extractReportedFingerprints([comment])
        .has(script.fingerprint(findings)),
    ).toBe(true);
    // A hand-edited comment without a block never poisons the dedupe.
    expect(
      script.extractReportedFingerprints(["no block here", null]).size,
    ).toBe(0);
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
    expect(
      res.status,
      `stdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
    ).not.toBe(0);
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
      expect(
        findings.map((f) => f.key).sort(),
        `${repo}: ${JSON.stringify(findings)}`,
      ).toEqual(expectByRepo[repo]);
      expect(findings.every((f) => f.kind === "actions-permission-drift")).toBe(
        true,
      );
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
    const sha = plan[0].actionsPuts.find(
      (p) => p.key === "sha_pinning_required",
    );
    expect(sha.endpoint).toBe(
      "repos/Adam-S-Daniel/cms-platform/actions/permissions",
    );
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

  // ── READ-ONLY DEGRADED path (the Contents-gating fix) ─────────────────────
  // A read-only Administration:Read CI token gets a repo object with the
  // merge-setting keys ENTIRELY ABSENT (GitHub gates them behind Contents
  // read+WRITE). The audit must NOT abort (the removed delete_branch_on_merge
  // canary), must NOT count the absent keys as drift, and must still diff the
  // visible flags + rulesets + actions-permissions surface.
  test("(n) DEGRADED: fetchLive never throws on a read-only token; absent merge flags are flag-not-visible informationals, not drift; visible flags + rulesets + actions still diff", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    // Simulate the read-only capture: the Contents-gated keys are gone.
    const degradedRepo = { ...fixture("cms-platform.repo.json") };
    for (const k of CONTENTS_GATED_KEYS) delete degradedRepo[k];
    const rulesetBody = fixture("cms-platform.ruleset-main.json");
    const api = fakeApi({
      [`repos/${repo}`]: degradedRepo,
      [`repos/${repo}/rulesets?per_page=100`]: [
        { id: rulesetBody.id, source_type: "Repository" },
      ],
      [`repos/${repo}/rulesets/${rulesetBody.id}`]: rulesetBody,
      // actions/permissions IS readable (Administration:Read) — THE gate passes.
      [`repos/${repo}/actions/permissions`]: fixture(
        "cms-platform.actions-permissions.json",
      ),
      // public repo -> the fork endpoint returns a value (no 422 here).
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        fixture("cms-platform.fork-pr-approval.json"),
    });

    // The removed canary must NOT abort a correctly read-only token.
    let live;
    expect(() => {
      live = script.fetchLive(repo, null, api);
    }).not.toThrow();

    // Diff exactly as scanRepos does (flags/rulesets, then actions-permissions).
    const diff = script.diffRepo({
      repo,
      desiredSettings: script.effectiveSettings(manifest, repo),
      desiredRulesets: script.desiredRulesets(manifest, repo),
      liveRepo: live.liveRepo,
      liveRulesets: live.liveRulesets,
    });
    script.diffActionsPermissions(
      repo,
      script.effectiveActionsPermissions(manifest, repo),
      live.liveActionsPermissions,
      diff.findings,
      diff.informational,
    );

    // Every absent Contents-gated key is INFORMATIONAL flag-not-visible.
    const notVisible = diff.informational.filter(
      (i) => i.kind === "flag-not-visible",
    );
    expect(notVisible.map((i) => i.key).sort()).toEqual(
      [...CONTENTS_GATED_KEYS].sort(),
    );
    for (const i of notVisible) {
      expect(i.repo).toBe(repo);
      expect(i.fixSkip).toBe(true);
      expect(i.reason).toMatch(/Contents/);
    }
    // NONE of the skipped keys became a flag-drift finding (no bogus drift).
    expect(diff.findings.filter((f) => f.kind === "flag-drift")).toEqual([]);
    // The VISIBLE flags (has_*/default_branch) still diffed — and matched.
    // The ruleset still diffed — and matched (zero ruleset findings).
    expect(
      diff.findings.filter((f) => String(f.kind).startsWith("ruleset")),
    ).toEqual([]);
    // Actions-permissions STILL diffs on the degraded token — the as-found
    // drift (sha false->true, fork first_time->all_external) is intact.
    expect(
      diff.findings
        .filter((f) => f.kind === "actions-permission-drift")
        .map((f) => f.key)
        .sort(),
    ).toEqual(["approval_policy", "sha_pinning_required"]);

    // --fix is driven off FINDINGS, so an absent (skipped) key is naturally
    // excluded from the flag PATCH body — buildFixPlan never PATCHes it.
    const plan = script.buildFixPlan(manifest, [
      {
        repo,
        findings: diff.findings,
        informational: diff.informational,
        liveRepo: live.liveRepo,
        liveRulesets: live.liveRulesets,
        liveActionsPermissions: live.liveActionsPermissions,
      },
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0].patchBody).toEqual({}); // no Contents-gated key PATCHed
    for (const k of CONTENTS_GATED_KEYS)
      expect(plan[0].patchBody).not.toHaveProperty(k);
  });

  test("(o) DEGRADED describe: a flag-not-visible line renders as an informational notice, never a drift finding", () => {
    // A visible-flag drift on the same degraded read still surfaces as a real
    // finding — proving flag-not-visible does not mask genuine drift.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const degradedRepo = {
      ...fixture("cms-platform.repo.json"),
      has_wiki: true,
    }; // manifest: false
    for (const k of CONTENTS_GATED_KEYS) delete degradedRepo[k];
    const { findings, informational } = script.diffRepo({
      repo,
      desiredSettings: script.effectiveSettings(manifest, repo),
      desiredRulesets: script.desiredRulesets(manifest, repo),
      liveRepo: degradedRepo,
      liveRulesets: [fixture("cms-platform.ruleset-main.json")],
    });
    // The visible has_wiki flip is a real flag-drift; the absent merge keys are not.
    expect(
      findings.filter((f) => f.kind === "flag-drift").map((f) => f.key),
    ).toEqual(["has_wiki"]);
    expect(
      informational.filter((i) => i.kind === "flag-not-visible").length,
    ).toBe(CONTENTS_GATED_KEYS.length);
  });

  test("(p) THE GATE SURVIVES: a token lacking Administration:Read (actions/permissions has no `enabled`, or 403) STILL fails loud — never silent drift", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    // `enabled` missing -> the exact "lacks Administration: Read" operational throw.
    const apiNoEnabled = fakeApi({
      [`repos/${repo}/actions/permissions`]: { message: "Not Found" }, // no `enabled`
    });
    expect(() =>
      script.fetchActionsPermissions(repo, null, apiNoEnabled),
    ).toThrow(/Administration: Read/);
    // A hard 403 from gh propagates as an operational failure (not swallowed).
    const api403 = fakeApi({
      [`repos/${repo}/actions/permissions`]: () => {
        const e = new Error(
          "gh: HTTP 403 Resource not accessible by personal access token",
        );
        e.stderr = "HTTP 403";
        throw e;
      },
    });
    expect(() => script.fetchActionsPermissions(repo, null, api403)).toThrow(
      /403/,
    );
  });

  test("(q) fetchActionsPermissions maps a fork-approval HTTP 422 to an operational SKIP (private repo), not a throw", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/actions/permissions`]: {
        enabled: true,
        allowed_actions: "all",
        sha_pinning_required: true,
      },
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        () => {
          const e = new Error(
            "gh: HTTP 422 not allowed for private repositories",
          );
          e.stderr = "not allowed for private repositories (HTTP 422)";
          throw e;
        },
    });
    let out;
    expect(() => {
      out = script.fetchActionsPermissions(repo, null, api);
    }).not.toThrow();
    expect(out.permissions.enabled).toBe(true);
    expect(out.forkApproval.skipped).toBe(true);
    expect(out.forkApproval.reason).toMatch(/422|private/i);
  });

  // The report used to claim an unqualified match even when `flag-not-visible`
  // entries proved some flags were never SEEN — so the daily audit printed "OK —
  // live settings match … on every scanned repo." over 11 unchecked keys. It now
  // surfaces an UNVERIFIABLE tally (still read-only, still exit 0).
  test("(r) UNVERIFIABLE: the per-repo OK line + the final summary are QUALIFIED when flags were not visible", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    // The same degraded read-only capture tests (n)/(o) simulate.
    const degradedRepo = { ...fixture("cms-platform.repo.json") };
    for (const k of CONTENTS_GATED_KEYS) delete degradedRepo[k];
    const { findings, informational } = script.diffRepo({
      repo,
      desiredSettings: script.effectiveSettings(manifest, repo),
      desiredRulesets: script.desiredRulesets(manifest, repo),
      liveRepo: degradedRepo,
      liveRulesets: [fixture("cms-platform.ruleset-main.json")],
    });
    expect(findings).toEqual([]); // clean scan — nothing is drift here
    expect(script.unverifiableKeys(informational).sort()).toEqual(
      [...CONTENTS_GATED_KEYS].sort(),
    );

    const okLine = script.repoOkLine(repo, 1, informational);
    expect(okLine).toContain(
      `${CONTENTS_GATED_KEYS.length} flag(s) UNVERIFIABLE (need Contents)`,
    );

    const summary = script.cleanScanSummary(informational);
    expect(summary).not.toBe(
      "OK — live settings match repo-settings.yml on every scanned repo.",
    );
    expect(summary).toMatch(/UNVERIFIABLE/);
    expect(summary).toContain(`${CONTENTS_GATED_KEYS.length} flag(s)`);
    expect(summary).toMatch(/read-only PAT cannot see/);
    expect(summary).toMatch(/not drift/);

    // ONE collapsed notice, naming every key (it was one notice per key).
    const notice = script.describeUnverifiable(
      script.unverifiableKeys(informational),
    );
    for (const k of CONTENTS_GATED_KEYS) expect(notice).toContain(k);

    // Unverifiable is NOT drift: the exit code is unchanged (a clean scan).
    expect(findings.length).toBe(0);
  });

  test("(s) VERIFIED: with nothing unverifiable both lines are BYTE-IDENTICAL to today's wording", () => {
    // The complete-payload half of (r): this is what stops a future refactor
    // from quietly reverting to the overstating text, so assert the EXACT
    // strings, not a substring.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const { findings, informational } = diffAgainstFixtures(
      script,
      manifest,
      repo,
    );
    expect(findings).toEqual([]);
    expect(script.unverifiableKeys(informational)).toEqual([]);

    expect(script.repoOkLine(repo, 1, informational)).toBe(
      "== Adam-S-Daniel/cms-platform: OK (flags + 1 ruleset(s) + actions permissions match)",
    );
    expect(script.cleanScanSummary(informational)).toBe(
      "OK — live settings match repo-settings.yml on every scanned repo.",
    );
    // A ruleset-unknown-field informational is NOT a flag visibility problem —
    // it must not qualify either line.
    const unknownField = [
      {
        repo,
        kind: "ruleset-unknown-field",
        ruleset: "main",
        key: "x",
        fixSkip: true,
      },
    ];
    expect(script.repoOkLine(repo, 1, unknownField)).toBe(
      "== Adam-S-Daniel/cms-platform: OK (flags + 1 ruleset(s) + actions permissions match)",
    );
    expect(script.cleanScanSummary(unknownField)).toBe(
      "OK — live settings match repo-settings.yml on every scanned repo.",
    );
  });

  // ── Environments surface (a FOURTH managed surface: GET/PUT
  // repos/{owner}/{repo}/environments/{name}, declared per repo with NO
  // shared defaults). No live GET of a real GitHub environment was possible
  // to capture from this sandbox (no gh/network access), so the fixtures
  // below are HAND-CONSTRUCTED against GitHub's documented, stable
  // environments API response shape (protection_rules[] with
  // required_reviewers / wait_timer rule types) rather than a literal
  // live-captured JSON file — unlike the repo/ruleset/actions-permissions
  // fixtures above, which genuinely were captured. ────────────────────────
  function writeManifest(yamlText) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cms-env-manifest-"));
    const file = path.join(dir, "repo-settings.yml");
    fs.writeFileSync(file, yamlText);
    return file;
  }

  // A live GET repos/{owner}/{repo}/environments/{name} response matching
  // the shipped manifest's `repo-settings` environment exactly (reviewer
  // 4205216, wait_timer 0, prevent_self_review false).
  const LIVE_ENV_MATCHED = {
    name: "repo-settings",
    protection_rules: [
      {
        id: 1,
        node_id: "env-rule-reviewers",
        type: "required_reviewers",
        prevent_self_review: false,
        reviewers: [
          {
            type: "User",
            reviewer: { id: 4205216, login: "Adam-S-Daniel", type: "User" },
          },
        ],
      },
      { id: 2, node_id: "env-rule-wait", type: "wait_timer", wait_timer: 0 },
    ],
  };

  // Every leaf drifted from the manifest: a different reviewer, a non-zero
  // wait_timer, prevent_self_review flipped true.
  const LIVE_ENV_DRIFTED = {
    name: "repo-settings",
    protection_rules: [
      {
        id: 1,
        node_id: "env-rule-reviewers",
        type: "required_reviewers",
        prevent_self_review: true,
        reviewers: [
          {
            type: "User",
            reviewer: { id: 999999, login: "someone-else", type: "User" },
          },
        ],
      },
      { id: 2, node_id: "env-rule-wait", type: "wait_timer", wait_timer: 30 },
    ],
  };

  test("normalizeEnvironment projects live protection_rules to {reviewers,wait_timer,prevent_self_review}", () => {
    const script = loadScript();
    expect(script.normalizeEnvironment(LIVE_ENV_MATCHED)).toEqual({
      reviewers: [{ type: "User", id: 4205216 }],
      wait_timer: 0,
      prevent_self_review: false,
    });
  });

  test("normalizeEnvironment: an ABSENT required_reviewers/wait_timer rule normalizes to GitHub's own defaults (never drift against nothing)", () => {
    const script = loadScript();
    expect(
      script.normalizeEnvironment({ name: "x", protection_rules: [] }),
    ).toEqual({
      reviewers: [],
      wait_timer: 0,
      prevent_self_review: false,
    });
    expect(script.normalizeEnvironment({})).toEqual({
      reviewers: [],
      wait_timer: 0,
      prevent_self_review: false,
    });
  });

  test("sortReviewers + normalizeEnvironment: reviewer ORDER never counts as drift (both sides sorted by type,id)", () => {
    const script = loadScript();
    const live = {
      protection_rules: [
        {
          type: "required_reviewers",
          prevent_self_review: false,
          reviewers: [
            { type: "Team", reviewer: { id: 20 } },
            { type: "User", reviewer: { id: 4205216 } },
          ],
        },
      ],
    };
    const findings = [];
    script.diffEnvironments(
      "o/r",
      {
        env: {
          reviewers: [
            { type: "User", id: 4205216 },
            { type: "Team", id: 20 },
          ],
        },
      },
      { env: live },
      findings,
      [],
    );
    expect(findings).toEqual([]);
  });

  test("diffEnvironments: a repo already at the desired baseline yields NO findings", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    const informational = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      { "repo-settings": LIVE_ENV_MATCHED },
      findings,
      informational,
    );
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });

  test("diffEnvironments: an EXISTING-BUT-DRIFTED environment emits one environment-drift finding PER drifted key", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      { "repo-settings": LIVE_ENV_DRIFTED },
      findings,
      [],
    );
    expect(findings.map((f) => f.key).sort()).toEqual([
      "prevent_self_review",
      "reviewers",
      "wait_timer",
    ]);
    expect(findings.every((f) => f.kind === "environment-drift")).toBe(true);
    expect(
      findings.every(
        (f) => f.repo === repo && f.environment === "repo-settings",
      ),
    ).toBe(true);
    const reviewersFinding = findings.find((f) => f.key === "reviewers");
    expect(reviewersFinding.live).toEqual([{ type: "User", id: 999999 }]);
    expect(reviewersFinding.desired).toEqual([{ type: "User", id: 4205216 }]);
  });

  test("diffEnvironments: a declared-but-ABSENT environment (404) emits environment-absent findings, not an operational skip", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    const informational = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      { "repo-settings": { absent: true } },
      findings,
      informational,
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.kind === "environment-absent")).toBe(true);
    expect(findings.every((f) => f.live === null)).toBe(true);
    expect(informational).toEqual([]); // absent is DRIFT, never an operational skip
  });

  // ── fetchEnvironments (the 404 -> {absent:true} contract) ─────────────────
  test("fetchEnvironments: 200 returns the live body verbatim", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/environments/repo-settings`]: LIVE_ENV_MATCHED,
    });
    const out = script.fetchEnvironments(repo, ["repo-settings"], null, api);
    expect(out).toEqual({ "repo-settings": LIVE_ENV_MATCHED });
  });

  test("fetchEnvironments: 404 maps to {absent:true} — DRIFT, never a throw", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/environments/repo-settings`]: () => {
        const e = new Error("gh: HTTP 404 Not Found");
        e.stderr = "Not Found (HTTP 404)";
        throw e;
      },
    });
    let out;
    expect(() => {
      out = script.fetchEnvironments(repo, ["repo-settings"], null, api);
    }).not.toThrow();
    expect(out).toEqual({ "repo-settings": { absent: true } });
  });

  test("fetchEnvironments: any OTHER error (e.g. 403) propagates as an operational failure, never swallowed", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/environments/repo-settings`]: () => {
        const e = new Error(
          "gh: HTTP 403 Resource not accessible by personal access token",
        );
        e.stderr = "HTTP 403";
        throw e;
      },
    });
    expect(() =>
      script.fetchEnvironments(repo, ["repo-settings"], null, api),
    ).toThrow(/403/);
  });

  test("fetchLive: NO environments call is made when the repo declares none (no wasted calls)", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/adamdaniel.ai"; // declares zero environments in the shipped manifest
    const api = fakeApi({
      [`repos/${repo}`]: fixture("adamdaniel.repo.json"),
      [`repos/${repo}/rulesets?per_page=100`]: [],
      [`repos/${repo}/actions/permissions`]: fixture(
        "adamdaniel.actions-permissions.json",
      ),
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        fixture("adamdaniel.fork-pr-approval.json"),
      // Deliberately NO route for an environments endpoint — if fetchLive
      // called one anyway, fakeApi's "unrouted endpoint" throw catches it.
    });
    let live;
    expect(() => {
      live = script.fetchLive(repo, null, api, []);
    }).not.toThrow();
    expect(live.liveEnvironments).toEqual({});
  });

  test("fetchLive: WITH declared environment names, the environments endpoint is called and bundled as liveEnvironments", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}`]: fixture("cms-platform.repo.json"),
      [`repos/${repo}/rulesets?per_page=100`]: [],
      [`repos/${repo}/actions/permissions`]: fixture(
        "cms-platform.actions-permissions.json",
      ),
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        fixture("cms-platform.fork-pr-approval.json"),
      [`repos/${repo}/environments/repo-settings`]: LIVE_ENV_MATCHED,
    });
    const live = script.fetchLive(repo, null, api, ["repo-settings"]);
    expect(live.liveEnvironments).toEqual({
      "repo-settings": LIVE_ENV_MATCHED,
    });
  });

  // ── ENV_FIX_FORBIDDEN — the self-gating escalation guard ──────────────────
  test("ENV_FIX_FORBIDDEN names exactly `repo-settings` (the environment that gates repo-settings-apply.yml)", () => {
    const script = loadScript();
    expect(script.ENV_FIX_FORBIDDEN).toEqual(["repo-settings"]);
  });

  test("(t) drift on the fix-forbidden `repo-settings` environment IS a finding (reaches the tracking issue)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      { "repo-settings": LIVE_ENV_DRIFTED },
      findings,
      [],
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.fixForbidden === true)).toBe(true);
  });

  test("(u) buildFixPlan NEVER puts a fix-forbidden environment — drifted case: no PUT, reported as envManualOnly", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      { "repo-settings": LIVE_ENV_DRIFTED },
      findings,
      [],
    );
    const plan = script.buildFixPlan(manifest, [
      {
        repo,
        findings,
        informational: [],
        liveRepo: fixture("cms-platform.repo.json"),
        liveRulesets: [fixture("cms-platform.ruleset-main.json")],
        liveActionsPermissions: liveActions(repo, {
          forkApproval: { approval_policy: "all_external_contributors" },
          permissions: { sha_pinning_required: true },
        }),
      },
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0].envPuts).toEqual([]);
    // envManualOnly is the structured signal buildFixPlan reports for a
    // fix-forbidden environment — printFixPlan (untested directly, like
    // printReport, matching this file's existing convention of not exporting
    // console-printing functions) renders it into the "FIX-FORBIDDEN
    // environment ... reconcile by hand" plan line.
    expect(plan[0].envManualOnly).toEqual(["repo-settings"]);
  });

  // (v) INVERTED, deliberately, in the same change as the behaviour it guarded.
  // It asserted the ORIGINAL strict rule — ENV_FIX_FORBIDDEN means --fix never
  // writes the environment at ANY drift state, so its first creation had to be a
  // click-through in the settings UI. That was stricter than the threat requires
  // and it left the as-code story with a manual hole. The rule is now CREATE-ONLY
  // (see ENV_FIX_FORBIDDEN in the script): creating from the manifest can only
  // produce the declared protected state, while UPDATING an existing one is the
  // real escalation path. The contract is covered by (w1)/(w2)/(w3) below —
  // absent-creates, exists-drifted-refuses, matches-no-op. Do NOT restore the
  // old assertion without re-arguing the threat model.

  // ── ENV_FIX_FORBIDDEN is CREATE-ONLY (the security asymmetry) ─────────────
  // ABSENT may be created: the body comes from the manifest, so the only
  // reachable outcome is the declared protected state. EXISTS-BUT-DRIFTED may
  // not: an approved apply holds administration:write and could otherwise strip
  // its own required reviewer, making every future apply unattended.
  function forbiddenEnvPlan(liveEnv) {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const manifest = script.loadManifest(
      path.resolve(__dirname, "..", "repo-settings.yml"),
    );
    const findings = [];
    script.diffEnvironments(
      repo,
      script.desiredEnvironments(manifest, repo),
      liveEnv,
      findings,
      [],
    );
    const plan = script.buildFixPlan(manifest, [
      {
        repo,
        findings,
        informational: [],
        liveRepo: fixture("cms-platform.repo.json"),
        liveRulesets: [fixture("cms-platform.ruleset-main.json")],
        liveActionsPermissions: liveActions(repo, {
          forkApproval: { approval_policy: "all_external_contributors" },
          permissions: { sha_pinning_required: true },
        }),
      },
    ]);
    return { findings, plan };
  }

  test("(w1) a forbidden environment that is ABSENT is CREATED — bootstrap without a UI click", () => {
    const { findings, plan } = forbiddenEnvPlan({
      "repo-settings": { absent: true },
    });
    expect(findings.some((f) => f.kind === "environment-absent")).toBe(true);
    expect(
      (plan[0].envPuts || []).map((p) => p.environment),
      "an absent gating environment must be creatable by --fix (create cannot weaken it)",
    ).toEqual(["repo-settings"]);
    expect(plan[0].envManualOnly || []).toEqual([]);
  });

  test("(w2) a forbidden environment that EXISTS but drifted is NEVER written", () => {
    // Present, but the required reviewer has been stripped — precisely the state
    // an apply must not be able to "converge" for its own gate.
    const { findings, plan } = forbiddenEnvPlan({
      "repo-settings": {
        protection_rules: [{ type: "wait_timer", wait_timer: 0 }],
      },
    });
    expect(
      findings.some((f) => f.kind === "environment-drift"),
      "a stripped reviewer must still be reported as drift",
    ).toBe(true);
    expect(
      (plan[0].envPuts || []).map((p) => p.environment),
      "an EXISTING forbidden environment must never be PUT — that is the escalation path",
    ).toEqual([]);
    expect(plan[0].envManualOnly || []).toEqual(["repo-settings"]);
  });

  test("(w4) the fix-forbidden suffix tells the TRUTH about each state", () => {
    // Regression: the suffix used to say "--fix will not create or write it" for
    // BOTH states, so an operator was told the opposite of what `--fix --yes`
    // then did to an ABSENT environment. Observed live on 2026-08-12.
    const script = loadScript();
    const absent = script.describeFinding({
      kind: "environment-absent",
      environment: "repo-settings",
      key: "reviewers",
      desired: [{ type: "User", id: 4205216 }],
      fixForbidden: true,
    });
    expect(
      absent,
      "an ABSENT forbidden env must NOT claim --fix refuses to create it",
    ).not.toMatch(/will not create/i);
    expect(absent).toMatch(/WILL create it/);

    const exists = script.describeFinding({
      kind: "environment-drift",
      environment: "repo-settings",
      key: "reviewers",
      live: [],
      desired: [{ type: "User", id: 4205216 }],
      fixForbidden: true,
    });
    expect(exists).toMatch(/will NOT write it/);
    expect(exists).toMatch(/reconcile by hand/);

    // A non-forbidden environment carries no suffix at all.
    const plain = script.describeFinding({
      kind: "environment-absent",
      environment: "staging",
      key: "reviewers",
      desired: [],
      fixForbidden: false,
    });
    expect(plain).not.toMatch(/fix-forbidden/);
  });

  test("(w3) a forbidden environment that MATCHES yields no finding and no write", () => {
    const { findings, plan } = forbiddenEnvPlan({
      "repo-settings": {
        protection_rules: [
          {
            type: "required_reviewers",
            prevent_self_review: false,
            reviewers: [
              {
                type: "User",
                reviewer: { id: 4205216, login: "Adam-S-Daniel" },
              },
            ],
          },
          { type: "wait_timer", wait_timer: 0 },
        ],
      },
    });
    expect(
      findings.filter((f) => String(f.kind).startsWith("environment-")),
    ).toEqual([]);
    expect(plan.length === 0 || (plan[0].envPuts || []).length === 0).toBe(
      true,
    );
  });

  test("(w) buildFixPlan DOES put a NON-forbidden drifted/absent environment (the general path proof)", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    environments:",
        "      staging:",
        "        reviewers:",
        "          - { type: User, id: 42 }",
        "        wait_timer: 5",
        "        prevent_self_review: true",
        "",
      ].join("\n"),
    );
    const script2 = script; // same instance; separate manifest file
    const manifest = script2.loadManifest(manifestPath);
    const repo = "Owner/Repo";
    const findings = [];
    script2.diffEnvironments(
      repo,
      script2.desiredEnvironments(manifest, repo),
      { staging: { absent: true } },
      findings,
      [],
    );
    expect(findings.every((f) => f.fixForbidden === false)).toBe(true);
    const plan = script2.buildFixPlan(manifest, [
      { repo, findings, informational: [], liveRepo: {}, liveRulesets: [] },
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0].envManualOnly).toEqual([]);
    expect(plan[0].envPuts).toEqual([
      {
        environment: "staging",
        endpoint: "repos/Owner/Repo/environments/staging",
        body: {
          reviewers: [{ type: "User", id: 42 }],
          wait_timer: 5,
          prevent_self_review: true,
        },
      },
    ]);
  });

  // ── manifest validation hard-fails (mirrors the MANAGED_REPO_KEY /
  // MANAGED_ACTIONS_PERMISSION_KEY hard-fail posture — loadManifest() must
  // reject an undeclared environment key or a malformed reviewer entry
  // before anything reaches a live PUT). ────────────────────────────────────
  test("loadManifest hard-fails on an environment key that is not a MANAGED_ENVIRONMENT_KEY", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    environments:",
        "      staging:",
        "        bogus_field: true",
        "",
      ].join("\n"),
    );
    expect(() => script.loadManifest(manifestPath)).toThrow(
      /repos\.Owner\/Repo\.environments\.staging\.bogus_field is not a MANAGED_ENVIRONMENT_KEY/,
    );
  });

  test("loadManifest hard-fails on a reviewer entry missing `type`", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    environments:",
        "      staging:",
        "        reviewers:",
        "          - { id: 42 }",
        "",
      ].join("\n"),
    );
    expect(() => script.loadManifest(manifestPath)).toThrow(
      /repos\.Owner\/Repo\.environments\.staging\.reviewers entry is missing "type"/,
    );
  });

  test("loadManifest hard-fails on a reviewer entry with a non-numeric `id`", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    environments:",
        "      staging:",
        "        reviewers:",
        '          - { type: User, id: "42" }',
        "",
      ].join("\n"),
    );
    expect(() => script.loadManifest(manifestPath)).toThrow(
      /repos\.Owner\/Repo\.environments\.staging\.reviewers entry has a non-numeric "id"/,
    );
  });

  test("loadManifest accepts a well-formed environments block (the positive control for the three hard-fails above)", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    environments:",
        "      staging:",
        "        reviewers:",
        "          - { type: User, id: 42 }",
        "          - { type: Team, id: 7 }",
        "        wait_timer: 5",
        "        prevent_self_review: true",
        "",
      ].join("\n"),
    );
    let manifest;
    expect(() => {
      manifest = script.loadManifest(manifestPath);
    }).not.toThrow();
    expect(script.desiredEnvironments(manifest, "Owner/Repo")).toEqual({
      staging: {
        reviewers: [
          { type: "User", id: 42 },
          { type: "Team", id: 7 },
        ],
        wait_timer: 5,
        prevent_self_review: true,
      },
    });
  });

  test("the shipped manifest's `repo-settings` environment resolves cleanly and is itself fix-forbidden", () => {
    // Locks the repo-settings.yml content addition (task item #5): the real
    // manifest must declare exactly reviewer 4205216, and that name must be
    // the one ENV_FIX_FORBIDDEN protects.
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const desired = script.desiredEnvironments(
      manifest,
      "Adam-S-Daniel/cms-platform",
    );
    expect(Object.keys(desired)).toEqual(["repo-settings"]);
    expect(desired["repo-settings"]).toEqual({
      reviewers: [{ type: "User", id: 4205216 }],
      wait_timer: 0,
      prevent_self_review: false,
    });
    expect(script.ENV_FIX_FORBIDDEN).toContain("repo-settings");
  });

  // ── Security-analysis surface (a FIFTH managed surface: Dependabot alerts +
  // Dependabot security updates, own GET/PUT/DELETE endpoint PER KEY where the
  // HTTP METHOD — not the request body — carries the enable/disable value;
  // added 2026-08-31). No live capture of these two endpoints was possible
  // from this sandbox (same "no gh/network access" constraint the hand-built
  // environments fixtures above note), so the fetch-path tests below drive
  // `fetchSecurityAnalysis` through `fakeApi` against the documented response
  // shapes (204-empty / 404 / 403 / the 200-JSON {enabled,paused} form) rather
  // than a literal live-captured JSON file. ─────────────────────────────────

  test("fetchSecurityAnalysis: an empty (204) body on both endpoints maps to {enabled:true}", () => {
    // The vulnerability-alerts endpoint's documented "enabled" response has
    // NO JSON body at all — an HTTP 204. fakeApi's function-route form
    // returns its value VERBATIM (never JSON.stringified), which is what
    // lets a route simulate a truly empty stdout string.
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => "",
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    const out = script.fetchSecurityAnalysis(repo, null, api);
    expect(out.vulnerabilityAlerts).toEqual({ enabled: true });
    expect(out.automatedSecurityFixes).toEqual({ enabled: true });
  });

  test("fetchSecurityAnalysis: automated-security-fixes' 200 JSON {enabled,paused} shape maps to {enabled} (paused is read but never carried through)", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => "",
      [`repos/${repo}/automated-security-fixes`]: {
        enabled: false,
        paused: false,
      },
    });
    const out = script.fetchSecurityAnalysis(repo, null, api);
    expect(out.automatedSecurityFixes).toEqual({ enabled: false });
  });

  test("fetchSecurityAnalysis: a 404 on vulnerability-alerts maps to {enabled:false} — DRIFT, never a throw", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => {
        const e = new Error("gh: HTTP 404 Not Found");
        e.stderr = "HTTP 404";
        throw e;
      },
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    let out;
    expect(() => {
      out = script.fetchSecurityAnalysis(repo, null, api);
    }).not.toThrow();
    expect(out.vulnerabilityAlerts).toEqual({ enabled: false });
  });

  test("fetchSecurityAnalysis: a 403 on vulnerability-alerts is an operational SKIP, not a throw", () => {
    // GUARD: this is the departure from "a GitHub 404 means not authorized" —
    // see fetchSecurityAnalysisKey's header comment for why a 404 here is
    // safe to read as "genuinely disabled" (fetchActionsPermissions has
    // already proven Administration:Read on this token/repo earlier in the
    // same fetchLive call). A 403 gets the DIFFERENT, informational-skip
    // treatment: the read-only PATs predate this surface, so a scope gap is
    // expected on day one and must not take the whole scan down.
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => {
        const e = new Error(
          "gh: HTTP 403 Resource not accessible by personal access token",
        );
        e.stderr = "HTTP 403";
        throw e;
      },
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    let out;
    expect(() => {
      out = script.fetchSecurityAnalysis(repo, null, api);
    }).not.toThrow();
    expect(out.vulnerabilityAlerts.skipped).toBe(true);
    expect(out.vulnerabilityAlerts.reason).toMatch(/vulnerability-alerts/);
    expect(out.vulnerabilityAlerts.reason).toMatch(/403/);
  });

  test("fetchSecurityAnalysis: any OTHER error (e.g. HTTP 500) propagates unchanged, never swallowed", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => {
        const e = new Error("gh: HTTP 500 Internal Server Error");
        e.stderr = "HTTP 500";
        throw e;
      },
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    expect(() => script.fetchSecurityAnalysis(repo, null, api)).toThrow(/500/);
  });

  test("fetchSecurityAnalysis: a non-empty non-JSON body is a guarded operational error, not a raw SyntaxError", () => {
    // Locks the JSON.parse guard: a genuinely malformed body must name the
    // endpoint in a clear error, never bubble up a bare "Unexpected token" it
    // would take a stack trace to attribute to this endpoint.
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: () => "not json",
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    let threw;
    try {
      script.fetchSecurityAnalysis(repo, null, api);
    } catch (e) {
      threw = e;
    }
    expect(threw).toBeInstanceOf(Error);
    expect(threw).not.toBeInstanceOf(SyntaxError);
    expect(threw.message).toContain("vulnerability-alerts");
  });

  test("fetchSecurityAnalysis: a parsed JSON body with no boolean `enabled` is an operational failure, never a silent {enabled:true} default", () => {
    // The {enabled:true} default is legitimate ONLY for the empty/204 shape
    // (handled before JSON.parse ever runs) — a body that DID parse but
    // carries no boolean `enabled` is an unexpected shape and must fail loud.
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: { some: "unexpected shape" },
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    expect(() => script.fetchSecurityAnalysis(repo, null, api)).toThrow(
      /vulnerability-alerts/,
    );
  });

  test("fetchSecurityAnalysis: a self-raised shape error whose BODY contains \"Not Found\" still throws — it is never re-read as {enabled:false}", () => {
    // REGRESSION GUARD. The unexpected-shape error interpolates the raw
    // response body into its message, and the catch below it status-matches on
    // /HTTP 404|Not Found/i. Untagged, a success body merely CONTAINING that
    // text would be caught by this function's OWN error and silently downgraded
    // to `{enabled:false}` — reporting "Dependabot alerts are off" for a repo
    // whose alerts were never actually read. The shapeError tag is what keeps a
    // failure this module raised out of the transport-status matching.
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}/vulnerability-alerts`]: { message: "Not Found" },
      [`repos/${repo}/automated-security-fixes`]: () => "",
    });
    expect(() => script.fetchSecurityAnalysis(repo, null, api)).toThrow(
      /unexpected JSON shape/,
    );
  });

  test("diffSecurityAnalysis: a repo already at the desired baseline yields NO findings and NO informationals", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const desired = {
      vulnerability_alerts: true,
      automated_security_fixes: true,
    };
    const live = {
      vulnerabilityAlerts: { enabled: true },
      automatedSecurityFixes: { enabled: true },
    };
    const findings = [];
    const informational = [];
    script.diffSecurityAnalysis(repo, desired, live, findings, informational);
    expect(findings).toEqual([]);
    expect(informational).toEqual([]);
  });

  test("diffSecurityAnalysis: a live false against desired true is exactly one endpoint-tagged security-analysis-drift finding", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const desired = {
      vulnerability_alerts: true,
      automated_security_fixes: true,
    };
    const live = {
      vulnerabilityAlerts: { enabled: false },
      automatedSecurityFixes: { enabled: true },
    };
    const findings = [];
    const informational = [];
    script.diffSecurityAnalysis(repo, desired, live, findings, informational);
    expect(findings).toEqual([
      {
        repo,
        kind: "security-analysis-drift",
        key: "vulnerability_alerts",
        endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
        live: false,
        desired: true,
      },
    ]);
    expect(informational).toEqual([]);
  });

  test("diffSecurityAnalysis: a {skipped:true} live entry is ONE security-analysis-skipped informational and ZERO findings", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const desired = {
      vulnerability_alerts: true,
      automated_security_fixes: true,
    };
    const live = {
      vulnerabilityAlerts: {
        skipped: true,
        reason:
          "vulnerability-alerts returned HTTP 403 — the read token lacks this surface",
      },
      automatedSecurityFixes: { enabled: true },
    };
    const findings = [];
    const informational = [];
    script.diffSecurityAnalysis(repo, desired, live, findings, informational);
    expect(findings).toEqual([]);
    expect(informational).toEqual([
      {
        repo,
        kind: "security-analysis-skipped",
        key: "vulnerability_alerts",
        endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
        reason:
          "vulnerability-alerts returned HTTP 403 — the read token lacks this surface",
        fixSkip: true,
      },
    ]);
  });

  // buildFixPlan ordering + methods — THE DEPENDENCY-ORDER REGRESSION GUARD:
  // Dependabot security updates require Dependabot alerts to already be on,
  // so an ENABLE must land vulnerability_alerts BEFORE automated_security_
  // fixes, and a DISABLE must land automated_security_fixes BEFORE
  // vulnerability_alerts (undo the dependent feature first). Both cases below
  // deliberately feed the findings array in the OPPOSITE order from what
  // buildFixPlan must emit, so a regression that just preserved input order
  // (instead of enforcing the real dependency) would fail this test.
  test("buildFixPlan: security-analysis ENABLE order is vulnerability_alerts THEN automated_security_fixes (the dependency-order regression guard)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [
      {
        repo,
        kind: "security-analysis-drift",
        key: "automated_security_fixes",
        endpoint: script.AUTOMATED_SECURITY_FIXES_ENDPOINT,
        live: false,
        desired: true,
      },
      {
        repo,
        kind: "security-analysis-drift",
        key: "vulnerability_alerts",
        endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
        live: false,
        desired: true,
      },
    ];
    const plan = script.buildFixPlan(manifest, [
      { repo, findings, informational: [], liveRepo: {}, liveRulesets: [] },
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0].securityWrites).toEqual([
      {
        endpoint: `repos/${repo}/vulnerability-alerts`,
        method: "PUT",
        key: "vulnerability_alerts",
        desired: true,
      },
      {
        endpoint: `repos/${repo}/automated-security-fixes`,
        method: "PUT",
        key: "automated_security_fixes",
        desired: true,
      },
    ]);
  });

  test("buildFixPlan: security-analysis DISABLE order is automated_security_fixes THEN vulnerability_alerts (the dependency-order regression guard, reversed)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const repo = "Adam-S-Daniel/cms-platform";
    const findings = [
      {
        repo,
        kind: "security-analysis-drift",
        key: "vulnerability_alerts",
        endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
        live: true,
        desired: false,
      },
      {
        repo,
        kind: "security-analysis-drift",
        key: "automated_security_fixes",
        endpoint: script.AUTOMATED_SECURITY_FIXES_ENDPOINT,
        live: true,
        desired: false,
      },
    ];
    const plan = script.buildFixPlan(manifest, [
      { repo, findings, informational: [], liveRepo: {}, liveRulesets: [] },
    ]);
    expect(plan.length).toBe(1);
    expect(plan[0].securityWrites).toEqual([
      {
        endpoint: `repos/${repo}/automated-security-fixes`,
        method: "DELETE",
        key: "automated_security_fixes",
        desired: false,
      },
      {
        endpoint: `repos/${repo}/vulnerability-alerts`,
        method: "DELETE",
        key: "vulnerability_alerts",
        desired: false,
      },
    ]);
  });

  test("describeFinding: security-analysis-drift names the key and the endpoint", () => {
    const script = loadScript();
    const line = script.describeFinding({
      repo: "o/r",
      kind: "security-analysis-drift",
      key: "vulnerability_alerts",
      endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
      live: false,
      desired: true,
    });
    expect(line).toContain("vulnerability_alerts");
    expect(line).toContain(script.VULNERABILITY_ALERTS_ENDPOINT);
    expect(line).toContain("false");
    expect(line).toContain("true");
  });

  test("describeInformational: security-analysis-skipped reads as an OPERATIONAL skip, never as drift", () => {
    const script = loadScript();
    const line = script.describeInformational({
      repo: "o/r",
      kind: "security-analysis-skipped",
      key: "vulnerability_alerts",
      endpoint: script.VULNERABILITY_ALERTS_ENDPOINT,
      reason:
        "vulnerability-alerts returned HTTP 403 — the read token lacks this surface",
      fixSkip: true,
    });
    expect(line).toMatch(/SKIPPED/);
    expect(line).toMatch(/OPERATIONAL skip/);
    expect(line).toMatch(/NOT drift/);
    // A real drift line always carries the live -> desired arrow; the skip
    // line must not, or it would read as an (unresolved) drift finding.
    expect(line).not.toContain("->");
  });

  test("loadManifest hard-fails on a non-boolean security_analysis_defaults value", () => {
    // These two endpoints are enable/disable only (PUT vs. DELETE with no
    // body) — a string value has no PUT payload to carry it, so a typo like
    // `"true"` (a truthy STRING, not the boolean) must fail loudly at load
    // time rather than silently reach buildFixPlan's `f.desired ? "PUT" :
    // "DELETE"` truthiness check and coerce to the same outcome by accident.
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo: {}",
        "security_analysis_defaults:",
        '  vulnerability_alerts: "true"',
        "",
      ].join("\n"),
    );
    expect(() => script.loadManifest(manifestPath)).toThrow(
      /security_analysis_defaults\.vulnerability_alerts must be a boolean/,
    );
  });

  test("loadManifest hard-fails on an undeclared repos.<repo>.security_analysis key", () => {
    const script = loadScript();
    const manifestPath = writeManifest(
      [
        "version: 1",
        "repos:",
        "  Owner/Repo:",
        "    security_analysis:",
        "      grouped_security_updates: true",
        "",
      ].join("\n"),
    );
    expect(() => script.loadManifest(manifestPath)).toThrow(
      /repos\.Owner\/Repo\.security_analysis\.grouped_security_updates is not a MANAGED_SECURITY_ANALYSIS_KEY/,
    );
  });

  // ── fetchLive gating (mirrors the two existing environments-gating tests
  // above — same backward-compatibility shape, one surface further out): a
  // NEW positional arg defaulting to [] must never break an existing 3- or
  // 4-arg fetchLive call, so fakeApi's closed route map (throws "unrouted
  // endpoint" on anything not listed) is the proof the fetch is genuinely
  // conditional and not merely "usually empty". ────────────────────────────
  test("fetchLive: NO security-analysis call is made when desiredSecurityKeys is omitted/empty (no wasted calls, no break on old call sites)", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/adamdaniel.ai";
    const api = fakeApi({
      [`repos/${repo}`]: fixture("adamdaniel.repo.json"),
      [`repos/${repo}/rulesets?per_page=100`]: [],
      [`repos/${repo}/actions/permissions`]: fixture(
        "adamdaniel.actions-permissions.json",
      ),
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        fixture("adamdaniel.fork-pr-approval.json"),
      // Deliberately NO route for vulnerability-alerts / automated-security-
      // fixes — if fetchLive called either anyway, fakeApi's "unrouted
      // endpoint" throw catches it, exactly like the environments-gating
      // test this one mirrors.
    });
    let live;
    expect(() => {
      live = script.fetchLive(repo, null, api, []);
    }).not.toThrow();
    expect(live.liveSecurityAnalysis).toEqual({});
  });

  test("fetchLive: WITH desiredSecurityKeys, both endpoints are called and bundled as liveSecurityAnalysis", () => {
    const script = loadScript();
    const repo = "Adam-S-Daniel/cms-platform";
    const api = fakeApi({
      [`repos/${repo}`]: fixture("cms-platform.repo.json"),
      [`repos/${repo}/rulesets?per_page=100`]: [],
      [`repos/${repo}/actions/permissions`]: fixture(
        "cms-platform.actions-permissions.json",
      ),
      [`repos/${repo}/actions/permissions/fork-pr-contributor-approval`]:
        fixture("cms-platform.fork-pr-approval.json"),
      [`repos/${repo}/vulnerability-alerts`]: () => "",
      [`repos/${repo}/automated-security-fixes`]: { enabled: true },
    });
    const live = script.fetchLive(
      repo,
      null,
      api,
      [],
      ["vulnerability_alerts", "automated_security_fixes"],
    );
    expect(live.liveSecurityAnalysis).toEqual({
      vulnerabilityAlerts: { enabled: true },
      automatedSecurityFixes: { enabled: true },
    });
  });
});

// ── write-risk classification (the gate narrowing) ──────────────────────────
//
// scripts/repo-settings-write-risk.js decides which convergences a human must
// approve. Getting it wrong in one direction costs a click; getting it wrong
// in the other performs an unattended admin write that reduced protection on a
// production repo. So every case below is written from the second direction:
// the question each asks is "could this write leave the repo with FEWER
// constraints than it has now?", and anything the classifier cannot answer
// must come back GATED.
const RISK_PATH = path.resolve(__dirname, "../scripts/repo-settings-write-risk.js");
function loadRisk() {
  delete require.cache[require.resolve(RISK_PATH)];
  return require(RISK_PATH);
}
// A ruleset body carrying one required_status_checks rule with `contexts`.
function rsc(contexts, extraParams = {}) {
  return {
    name: "main",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: contexts.map((context) => ({ context })),
          ...extraParams,
        },
      },
    ],
  };
}
const verdict = (w) => loadRisk().classifyWrite(w).verdict;

test.describe("repo-settings write-risk classification", () => {
  test("the REAL outstanding drift (#310) classifies SAFE, so it applies unattended", () => {
    // adamdaniel.ai's `main` ruleset is missing `prerelease-guard /
    // prerelease-guard`; the manifest has it. That single item was pending
    // from 2026-08-27 to 2026-08-31 while four runs asked a human to approve
    // it. Adding a required check cannot reduce protection — this is exactly
    // the case the narrowing exists for, so it is asserted on the real values
    // rather than on a synthetic pair.
    const live = rsc([
      "e2e / e2e",
      "editorial / validate-content",
      "parity / parity",
      "preview-media / preview-media",
      "scan / scan",
      "visual-regression / approve-regression",
    ]);
    const desired = rsc([
      "e2e / e2e",
      "editorial / validate-content",
      "parity / parity",
      "prerelease-guard / prerelease-guard",
      "preview-media / preview-media",
      "scan / scan",
      "visual-regression / approve-regression",
    ]);
    const c = loadRisk().classifyWrite({
      kind: "ruleset-put",
      name: "main",
      live,
      desired,
    });
    expect(c.verdict).toBe("safe");
    expect(c.reason).toContain("prerelease-guard / prerelease-guard");
  });

  test("REMOVING a required check is gated, and that is the same diff backwards", () => {
    // The mirror of the test above, and the one that matters: if the
    // classifier is direction-blind, both read the same and an unattended run
    // strips a repo's required checks.
    const six = [
      "e2e / e2e",
      "editorial / validate-content",
      "parity / parity",
      "preview-media / preview-media",
      "scan / scan",
      "visual-regression / approve-regression",
    ];
    const c = loadRisk().classifyWrite({
      kind: "ruleset-put",
      name: "main",
      live: rsc([...six, "prerelease-guard / prerelease-guard"]),
      desired: rsc(six),
    });
    expect(c.verdict).toBe("gated");
    expect(c.reason).toMatch(/required check\(s\) removed/);
  });

  test("relaxing enforcement, adding a bypass actor, or moving conditions is gated", () => {
    const base = rsc(["a / a"]);
    const relaxed = { ...base, enforcement: "disabled" };
    expect(
      verdict({ kind: "ruleset-put", name: "main", live: base, desired: relaxed }),
    ).toBe("gated");
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: base,
        desired: { ...base, bypass_actors: [{ actor_id: 5, actor_type: "Integration", bypass_mode: "always" }] },
      }),
    ).toBe("gated");
    // …and removing one is fine: fewer ways around the rules.
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: { ...base, bypass_actors: [{ actor_id: 5, actor_type: "Integration", bypass_mode: "always" }] },
        desired: base,
      }),
    ).toBe("safe");
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: base,
        desired: {
          ...base,
          conditions: { ref_name: { include: ["refs/heads/nothing"], exclude: [] } },
        },
      }),
    ).toBe("gated");
  });

  test("dropping a whole rule is gated; adding one is safe", () => {
    const withChecks = rsc(["a / a"]);
    const withChecksAndDeletion = {
      ...withChecks,
      rules: [...withChecks.rules, { type: "deletion" }],
    };
    expect(
      verdict({ kind: "ruleset-put", name: "main", live: withChecks, desired: withChecksAndDeletion }),
    ).toBe("safe");
    expect(
      verdict({ kind: "ruleset-put", name: "main", live: withChecksAndDeletion, desired: withChecks }),
    ).toBe("gated");
  });

  test("a pull_request rule's parameters are ALWAYS gated — direction is not modelled there", () => {
    // `required_approving_review_count`, the dismiss-stale flags and
    // `allowed_merge_methods` all live here and all have a weakening
    // direction. Rather than model five more orderings, the classifier
    // declines to reason about the rule at all. That is deliberate, and this
    // test is what stops someone "completing" it casually.
    const pr = (count) => ({
      name: "main",
      target: "branch",
      enforcement: "active",
      conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      bypass_actors: [],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: count } },
      ],
    });
    expect(
      verdict({ kind: "ruleset-put", name: "main", live: pr(1), desired: pr(2) }),
    ).toBe("gated");
    expect(
      verdict({ kind: "ruleset-put", name: "main", live: pr(2), desired: pr(1) }),
    ).toBe("gated");
  });

  test("it FAILS CLOSED on anything it has never seen", () => {
    // The property the whole design rests on: this is an allowlist. A ruleset
    // key GitHub adds next year, a required_status_checks parameter nobody has
    // modelled, an unknown write kind — every one of them must reach a human,
    // not the ungated lane.
    const base = rsc(["a / a"]);
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: base,
        desired: { ...base, some_future_github_key: true },
      }),
    ).toBe("gated");
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: rsc(["a / a"]),
        desired: rsc(["a / a"], { some_future_param: 3 }),
      }),
    ).toBe("gated");
    expect(verdict({ kind: "who-knows", key: "x" })).toBe("gated");
    expect(verdict(null)).toBe("gated");
    // A context entry that is more than a bare `context` is a different
    // assertion (an integration_id pin), so it is not covered by "additions
    // only are safe".
    expect(
      verdict({
        kind: "ruleset-put",
        name: "main",
        live: rsc(["a / a"]),
        desired: {
          ...rsc(["a / a"]),
          rules: [
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                do_not_enforce_on_create: false,
                required_status_checks: [
                  { context: "a / a" },
                  { context: "b / b", integration_id: 15368 },
                ],
              },
            },
          ],
        },
      }),
    ).toBe("gated");
  });

  test("repo flags are allowlisted by VALUE, not by key", () => {
    // Disabling a merge method removes a way to land code; enabling one adds
    // one. Same key, opposite verdicts.
    expect(
      verdict({ kind: "flag", key: "allow_rebase_merge", live: true, desired: false }),
    ).toBe("safe");
    expect(
      verdict({ kind: "flag", key: "allow_rebase_merge", live: false, desired: true }),
    ).toBe("gated");
    expect(
      verdict({ kind: "flag", key: "delete_branch_on_merge", live: false, desired: true }),
    ).toBe("safe");
    // Cosmetic keys are deliberately absent from the list — unmodelled means
    // gated, which costs a click and never a surprise.
    expect(
      verdict({ kind: "flag", key: "squash_merge_commit_title", live: "COMMIT_OR_PR_TITLE", desired: "PR_TITLE" }),
    ).toBe("gated");
  });

  test("Actions permissions follow the same direction rule", () => {
    expect(
      verdict({ kind: "actions-permission", key: "sha_pinning_required", live: false, desired: true }),
    ).toBe("safe");
    expect(
      verdict({ kind: "actions-permission", key: "sha_pinning_required", live: true, desired: false }),
    ).toBe("gated");
    expect(
      verdict({
        kind: "actions-permission",
        key: "approval_policy",
        live: "first_time_contributors",
        desired: "all_external_contributors",
      }),
    ).toBe("safe");
    expect(
      verdict({
        kind: "actions-permission",
        key: "approval_policy",
        live: "all_external_contributors",
        desired: "first_time_contributors",
      }),
    ).toBe("gated");
    // An unknown live value means the DIRECTION is unknown, not that the move
    // is fine.
    expect(
      verdict({
        kind: "actions-permission",
        key: "approval_policy",
        live: null,
        desired: "all_external_contributors",
      }),
    ).toBe("gated");
  });

  test("creating a ruleset or an environment only ever adds", () => {
    // GitHub enforces the UNION of a repo's rulesets, so one that does not
    // exist yet cannot be relaxing anything by coming into existence; and
    // buildFixPlan only ever emits an environment PUT on the CREATE path
    // (ENV_FIX_FORBIDDEN), where the body is the manifest's own.
    expect(verdict({ kind: "ruleset-post", name: "new", desired: rsc(["a / a"]) })).toBe("safe");
    expect(
      verdict({ kind: "environment-put", name: "repo-settings", desired: { reviewers: [] } }),
    ).toBe("safe");
  });

  test("classifyPlan aggregates, and one gated write gates the whole plan", () => {
    const risk = loadRisk();
    const plan = [
      {
        repo: "o/r",
        patchBody: { allow_rebase_merge: false },
        flagLive: { allow_rebase_merge: true },
        puts: [],
        posts: [],
        actionsPuts: [],
        envPuts: [],
      },
      {
        repo: "o/r2",
        patchBody: { allow_rebase_merge: true },
        flagLive: { allow_rebase_merge: false },
        puts: [],
        posts: [],
        actionsPuts: [],
        envPuts: [],
      },
    ];
    const c = risk.classifyPlan(plan);
    expect(c.writes.length).toBe(2);
    expect(c.safe.length).toBe(1);
    expect(c.gated.length).toBe(1);
    expect(c.gated[0].repo).toBe("o/r2");
  });

  test("planUnfixables names what no approval can fix", () => {
    // The other half of the noise problem: a plan can be non-empty and contain
    // nothing this tool will write. Asking a human to approve THAT is asking
    // for something they cannot give through this workflow.
    const risk = loadRisk();
    const un = risk.planUnfixables([
      {
        repo: "o/r",
        manualOnly: ["default_branch"],
        skipped: ["odd"],
        unmanaged: ["stray"],
        envManualOnly: ["repo-settings"],
      },
    ]);
    expect(un.length).toBe(4);
    expect(un.join("\n")).toContain("default_branch");
    expect(un.join("\n")).toContain("repo-settings");
    expect(risk.classifyPlan([{ repo: "o/r", manualOnly: ["default_branch"] }]).writes.length).toBe(0);
  });
});

// ── the classifier must know every bucket the plan can carry ────────────────
//
// This is the guard that was missing, and its absence was measured rather than
// imagined. `scripts/repo-settings-write-risk.js` merged on 2026-08-31 at
// 20:31; `securityWrites` (#355, Dependabot vulnerability alerts + automated
// security fixes) merged at 20:25 — six minutes earlier, on a branch cut before
// it. Both files merged CLEAN because they touch different regions, and every
// lint stayed green. But planWrites() iterated a hardcoded list of buckets, so
// security writes were invisible to it, which meant:
//
//   - a plan of ONLY security writes counted writes=0, took the "no applicable
//     writes" path, exited 0, and never applied — silently; and
//   - a plan mixing one safe ruleset write with a security DELETE counted
//     gated=0 and routed to the UNGATED lane, which would have disabled a
//     repo's security alerts with nobody asked.
//
// The second is a fail-OPEN in the module whose entire contract is failing
// closed. So the fix is not just "teach it about securityWrites" — it is this
// test, which reads buildFixPlan's OWN plan.push() and fails the moment a new
// bucket appears that the classifier has not been taught.
//
// AST, not regex (the house rule): the subject is which properties a specific
// object literal carries, which is a question about code STRUCTURE.
const acorn = require("acorn");
const walk = require("acorn-walk");

test.describe("write-risk classifier vs. the real fix plan", () => {
  function planPushKeys() {
    const src = fs.readFileSync(SCRIPT_PATH, "utf8");
    const ast = acorn.parse(src, { ecmaVersion: "latest" });
    const found = [];
    walk.simple(ast, {
      CallExpression(n) {
        const c = n.callee;
        if (
          c.type === "MemberExpression" &&
          c.object &&
          c.object.name === "plan" &&
          c.property &&
          c.property.name === "push" &&
          n.arguments[0] &&
          n.arguments[0].type === "ObjectExpression"
        ) {
          for (const p of n.arguments[0].properties) {
            const k = p.key && (p.key.name || p.key.value);
            if (k) found.push(k);
          }
        }
      },
    });
    return found;
  }

  test("every key buildFixPlan emits is one the classifier knows", () => {
    const keys = planPushKeys();
    // Non-vacuity: if the AST walk stops finding the call, this test would
    // otherwise pass over an empty list forever.
    expect(
      keys.length,
      "found no plan.push({...}) in audit-repo-settings.js — the walk is broken, " +
        "not the code under test",
    ).toBeGreaterThan(5);
    const known = loadRisk().PLAN_KNOWN_KEYS;
    const unknown = keys.filter((k) => !known.has(k));
    expect(
      unknown,
      `buildFixPlan emits ${JSON.stringify(unknown)}, which scripts/repo-settings-write-risk.js ` +
        "has never been taught. A bucket the classifier cannot see is a write the UNGATED " +
        "lane would apply unexamined. Add it to PLAN_WRITE_KEYS (and a classifyWrite case) " +
        "or to the unfixable/metadata lists, in the SAME PR that adds the surface.",
    ).toEqual([]);
  });

  test("an unrecognised bucket is GATED, not skipped", () => {
    // The structural half: even with the cross-check above, a bucket added
    // without running these lints must still fail closed at runtime.
    const risk = loadRisk();
    const c = risk.classifyPlan([{ repo: "o/r", someFutureSurface: [{ x: 1 }] }]);
    expect(c.writes.length, "an unknown bucket must COUNT as a write").toBe(1);
    expect(c.gated.length).toBe(1);
    expect(c.gated[0].reason).toMatch(/not known to the write-risk classifier/);
    // …but an EMPTY unknown bucket is not a write and must not gate anything,
    // or every plan would need a human forever.
    expect(risk.classifyPlan([{ repo: "o/r", someFutureSurface: [] }]).writes.length).toBe(0);
  });

  test("security analysis: enabling is safe, DISABLING needs a human", () => {
    const risk = loadRisk();
    const enable = risk.classifyPlan([
      {
        repo: "o/r",
        securityWrites: [
          { key: "vulnerability_alerts", desired: true, method: "PUT" },
          { key: "automated_security_fixes", desired: true, method: "PUT" },
        ],
      },
    ]);
    expect(enable.gated).toEqual([]);
    expect(enable.safe.length).toBe(2);

    const disable = risk.classifyPlan([
      {
        repo: "o/r",
        securityWrites: [
          { key: "vulnerability_alerts", desired: false, method: "DELETE" },
        ],
      },
    ]);
    expect(disable.safe).toEqual([]);
    expect(disable.gated.length).toBe(1);
    expect(disable.gated[0].reason).toMatch(/DISABLED/);
  });

  test("a security write mixed with a safe write still gates the whole plan", () => {
    // The exact shape that would have slipped through: one write the
    // classifier likes, one it never saw.
    const risk = loadRisk();
    const c = risk.classifyPlan([
      {
        repo: "o/r",
        patchBody: { allow_rebase_merge: false },
        flagLive: { allow_rebase_merge: true },
        securityWrites: [
          { key: "automated_security_fixes", desired: false, method: "DELETE" },
        ],
      },
    ]);
    expect(c.writes.length).toBe(2);
    expect(c.safe.length).toBe(1);
    expect(c.gated.length).toBe(1);
  });
});

// ── the classifier must compare like with like ─────────────────────────────
//
// MEASURED on the first real run of the ungated lane
// (https://github.com/Adam-S-Daniel/cms-platform/actions/runs/33437449511):
// `cms-feature-branches` came back NEEDS-REVIEW on BOTH consumers with the
// reason "`conditions` differs" — on two repos whose conditions were
// identical. The real delta was a bypass actor.
//
// Cause: normalizeRuleset SORTS the live side (rules by type, contexts by
// context, bypass actors, and the ref_name globs), while the manifest lists
// them in whatever order a human wrote them — and repo-settings.yml writes
// this ruleset's include list as cms, claude, feat, fix, chore, test, ci,
// docs. Comparing sorted against unsorted makes array ORDER read as a
// difference, so the walk hits `conditions` first and returns before it ever
// reaches the key that actually changed.
//
// It failed CLOSED, so nothing was waved through. But a classifier that gates
// ordinary tightenings on array order recreates the daily-approval habit this
// whole mechanism exists to end, and it reports the wrong reason while doing
// it. buildFixPlan therefore hands the classifier `desiredSorted` — the
// manifest body under the same normalization the live side already went
// through — and `body` stays raw because that is what gets PUT.
test.describe("write-risk classification is not fooled by array order", () => {
  test("a bypass-actor add is named as such, not as a `conditions` diff", () => {
    const script = loadScript();
    const risk = loadRisk();
    const manifest = script.loadManifest(MANIFEST_PATH);
    // The real incident, reproduced: `cms-feature-branches` is the one library
    // entry that declares a bypass actor, and live carries none — so the
    // manifest is ADDING one. (Live-has / manifest-hasn't is the mirror case
    // and is safe: fewer ways around the rules.)
    const scan = diffAgainstFixtures(
      script,
      manifest,
      "Adam-S-Daniel/adamdaniel.ai",
      {
        rulesets: [
          fixture("adamdaniel.ruleset-main.json"),
          { ...fixture("adamdaniel.ruleset-feature.json"), bypass_actors: [] },
        ],
      },
    );
    const plan = script.buildFixPlan(manifest, [scan]);
    expect(plan.length).toBe(1);
    expect(plan[0].puts.length).toBe(1);
    expect(plan[0].puts[0].name).toBe("cms-feature-branches");
    // The seam itself: the classifier's desired side must be normalized the
    // same way the live side is.
    expect(
      plan[0].puts[0].desiredSorted,
      "buildFixPlan must hand the classifier a normalized desired body",
    ).toEqual(script.sortRuleset(plan[0].puts[0].body));

    const c = risk.classifyPlan(plan);
    expect(c.gated.length, "removing a bypass actor is safe; ADDING one is not").toBe(1);
    expect(
      c.gated[0].reason,
      "the reason must name the key that actually changed — a wrong reason sends a " +
        "human to look at the wrong thing",
    ).toMatch(/bypass actor/);
    expect(c.gated[0].reason).not.toMatch(/`conditions` differs/);
  });

  test("array order alone is never a delta", () => {
    // The direct form of the same property, at the level the bug lived.
    const risk = loadRisk();
    const sorted = {
      name: "main",
      target: "branch",
      enforcement: "active",
      conditions: {
        ref_name: { include: ["refs/heads/a/**", "refs/heads/b/**"], exclude: [] },
      },
      bypass_actors: [],
      rules: [
        { type: "deletion" },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
            required_status_checks: [{ context: "a / a" }],
          },
        },
      ],
    };
    // Same ruleset, human-written order, plus ONE added required check.
    const scrambled = JSON.parse(JSON.stringify(sorted));
    scrambled.conditions.ref_name.include = ["refs/heads/b/**", "refs/heads/a/**"];
    scrambled.rules.reverse();
    scrambled.rules.find(
      (r) => r.type === "required_status_checks",
    ).parameters.required_status_checks = [{ context: "b / b" }, { context: "a / a" }];

    const plan = [
      {
        repo: "o/r",
        puts: [
          {
            name: "main",
            live: sorted,
            body: scrambled,
            desiredSorted: loadScript().sortRuleset(scrambled),
          },
        ],
      },
    ];
    const c = risk.classifyPlan(plan);
    expect(c.gated, "only the ADDED check differs; order must not gate").toEqual([]);
    expect(c.safe.length).toBe(1);
    expect(c.safe[0].reason).toMatch(/required check\(s\) added — b \/ b/);
  });
});

// A gated write must arrive at the reviewer as a DIFF, not as a full manifest
// body. #396: the approval issue said "1 bypass actor(s) added" and then
// printed two 1.2 kB ruleset bodies under "The full plan", with no way to see
// WHICH actor or WHAT else the PUT would move. The plan now carries the
// per-facet delta the audit already computed, and the gated reason names the
// actor.
test.describe("the plan carries a concise per-write diff (#396)", () => {
  function bypassActorPlan() {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const scan = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/adamdaniel.ai", {
      rulesets: [
        fixture("adamdaniel.ruleset-main.json"),
        { ...fixture("adamdaniel.ruleset-feature.json"), bypass_actors: [] },
      ],
    });
    return { script, plan: script.buildFixPlan(manifest, [scan]) };
  }

  test("a ruleset PUT carries `changes`: only the facets that differ, live -> desired", () => {
    const { plan } = bypassActorPlan();
    expect(plan[0].puts[0].changes).toEqual([
      {
        facet: "bypass_actors",
        live: [],
        desired: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],
      },
    ]);
  });

  test("the gated reason NAMES the added actor, not just a count", () => {
    const { plan } = bypassActorPlan();
    const c = loadRisk().classifyPlan(plan);
    expect(c.gated.length).toBe(1);
    expect(c.gated[0].reason).toMatch(/bypass actor\(s\) added: RepositoryRole 5 = admin \(bypass: always\)/);
  });

  test("planDocument renders every write with its verdict, reason and changes", () => {
    const { script, plan } = bypassActorPlan();
    const risk = loadRisk().classifyPlan(plan);
    const doc = script.planDocument(plan, risk);
    expect(doc.writes.length).toBe(1);
    expect(doc.writes[0]).toMatchObject({
      repo: "Adam-S-Daniel/adamdaniel.ai",
      kind: "ruleset-put",
      name: "cms-feature-branches",
      verdict: "gated",
    });
    expect(doc.writes[0].changes).toEqual(plan[0].puts[0].changes);
    expect(doc.unfixables).toEqual([]);
    // The document is what crosses the job boundary as JSON; it must survive it.
    expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
  });

  test("planDocument: a flag, an actions permission and a security write each carry a one-facet change", () => {
    const script = loadScript();
    const plan = [
      {
        repo: "o/r",
        patchBody: { allow_rebase_merge: false },
        flagLive: { allow_rebase_merge: true },
        actionsPuts: [
          {
            endpoint: "repos/o/r/actions/permissions",
            key: "sha_pinning_required",
            live: false,
            body: { enabled: true, allowed_actions: "all", sha_pinning_required: true },
          },
        ],
        securityWrites: [
          { endpoint: "repos/o/r/vulnerability-alerts", method: "PUT", key: "vulnerability_alerts", desired: true },
        ],
      },
    ];
    const doc = script.planDocument(plan, loadRisk().classifyPlan(plan));
    expect(doc.writes.map((w) => w.changes)).toEqual([
      [{ facet: "allow_rebase_merge", live: true, desired: false }],
      [{ facet: "sha_pinning_required", live: false, desired: true }],
      [{ facet: "vulnerability_alerts", live: null, desired: true }],
    ]);
    expect(doc.writes.every((w) => w.verdict === "safe")).toBe(true);
  });

  test("printFixPlan prints the changes ABOVE the full body, so the log reads the same way the issue does", () => {
    const { script, plan } = bypassActorPlan();
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(" "));
    try {
      script.printFixPlan(plan);
    } finally {
      console.log = orig;
    }
    const put = lines.findIndex((l) => /^   PUT repos\/Adam-S-Daniel\/adamdaniel\.ai\/rulesets\//.test(l));
    expect(put).toBeGreaterThan(-1);
    expect(lines[put + 1]).toMatch(/^     bypass_actors: \[\] -> \[\{"actor_id":5/);
    expect(lines[put + 2]).toMatch(/^     full body: \{"name":"cms-feature-branches"/);
  });
});

// Follow-up on #397: the first diff said `RepositoryRole#5 (always)` and the
// reviewer's reply was "What is RepositoryRole#5? And I'd like to see what
// ruleset cms-feature-branches is". An id is not an answer; neither is a name
// with nothing to click.
test.describe("the plan says WHAT the actor and the ruleset are (#397 review)", () => {
  test("describeActor decodes GitHub's fixed RepositoryRole ids", () => {
    const { describeActor } = loadRisk();
    expect(describeActor({ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" })).toBe(
      "RepositoryRole 5 = admin (bypass: always)",
    );
    expect(describeActor({ actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "pull_request" })).toBe(
      "RepositoryRole 4 = write (bypass: pull_request)",
    );
    expect(describeActor({ actor_id: 2, actor_type: "RepositoryRole" })).toBe("RepositoryRole 2 = maintain");
    // An id this table does not know is shown raw, never guessed.
    expect(describeActor({ actor_id: 9, actor_type: "RepositoryRole" })).toBe("RepositoryRole 9");
    expect(describeActor({ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" })).toBe(
      "OrganizationAdmin (bypass: always)",
    );
    expect(describeActor({ actor_id: 123, actor_type: "Team" })).toBe("Team 123");
  });

  test("a ruleset PUT carries `context`: the live ruleset's id, its settings URL and the refs it covers", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const scan = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/adamdaniel.ai", {
      rulesets: [
        fixture("adamdaniel.ruleset-main.json"),
        { ...fixture("adamdaniel.ruleset-feature.json"), bypass_actors: [] },
      ],
    });
    const plan = script.buildFixPlan(manifest, [scan]);
    const put = plan[0].puts[0];
    expect(put.context).toEqual({
      id: 15756474,
      url: "https://github.com/Adam-S-Daniel/adamdaniel.ai/rules/15756474",
      target: "branch",
      refs: [
        "refs/heads/chore/**",
        "refs/heads/ci/**",
        "refs/heads/claude/**",
        "refs/heads/cms/**",
        "refs/heads/docs/**",
        "refs/heads/feat/**",
        "refs/heads/fix/**",
        "refs/heads/test/**",
      ],
    });
    // …and it reaches the document the issue renders from.
    const doc = script.planDocument(plan, loadRisk().classifyPlan(plan));
    expect(doc.writes[0].context).toEqual(put.context);
  });

  test("the URL is derived when the live body carries no _links (older captures, other callers)", () => {
    const script = loadScript();
    const manifest = script.loadManifest(MANIFEST_PATH);
    const live = { ...fixture("adamdaniel.ruleset-feature.json"), bypass_actors: [] };
    delete live._links;
    const scan = diffAgainstFixtures(script, manifest, "Adam-S-Daniel/adamdaniel.ai", {
      rulesets: [fixture("adamdaniel.ruleset-main.json"), live],
    });
    const put = script.buildFixPlan(manifest, [scan])[0].puts[0];
    expect(put.context.url).toBe("https://github.com/Adam-S-Daniel/adamdaniel.ai/rules/15756474");
  });
});
