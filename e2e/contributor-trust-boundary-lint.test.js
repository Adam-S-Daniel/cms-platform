// @lane: local — pure-fs, PLATFORM lint (parses workflows with the `yaml`
// library and github-script bodies with acorn, never a regex over source)
// holding the contributor trust boundary for previews (#536).
//
// A preview at `https://preview-*.<apex>` receives the editor's OAuth token,
// so the code on it must never come from someone the site has not trusted.
// That holds only while every PR-facing workflow keeps fork code away from
// secrets and write tokens. The rules, and what they deliberately cannot see,
// are in e2e/contributor-trust-boundary-rules.js; the policy is
// docs/ADMIN-AUTH-SECURITY.md, "Outside contributors and previews".
//
// WHAT IS COVERED: this repo's own workflows (self-CI and the reusables) and
// the canonical thin callers under examples/site/, which are what make the
// reusables' EFFECTIVE triggers knowable: a reusable runs under its caller's
// event. The consumers' real callers are covered by the unregistered sibling
// "consumer-contributor-trust-boundary-lint.test.js" (the #244 lesson, the same
// split as the pin-comment lints), because on-triggers are excluded from
// pin-consistency's caller parity and a consumer can change them freely.
//
// Registered in playwright.config.js PLATFORM_META_SPECS: it reads the
// platform's own workflow definitions and repo-settings.yml.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { formatOffence, headRefs, lintWorkflows } = require("./contributor-trust-boundary-rules");

const REPO_ROOT = path.resolve(__dirname, "..");
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");
const TEMPLATES_DIR = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";

function readTree(dir, origin) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((name) => ({
      file: path.relative(REPO_ROOT, path.join(dir, name)),
      name,
      origin,
      text: fs.readFileSync(path.join(dir, name), "utf8"),
    }));
}

const PLATFORM = readTree(WORKFLOWS_DIR, "platform");
const TEMPLATES = readTree(TEMPLATES_DIR, "template");
// One parse of the whole tree, shared by every real-tree test below.
const REAL = lintWorkflows([...PLATFORM, ...TEMPLATES], { platformRepo: PLATFORM_REPO });

test.describe("the contributor trust boundary holds on the real tree", () => {
  test("the walk reached both trees", () => {
    expect(PLATFORM.length, "no platform workflows read").toBeGreaterThan(0);
    expect(TEMPLATES.length, "no examples/site thin callers read").toBeGreaterThan(0);
  });

  test("no workflow crosses the boundary", () => {
    expect(
      REAL.offences.map(formatOffence),
      "a contributor-reachable workflow crossed the trust boundary. A preview receives the " +
        "editor's token, so fork code must never run with secrets or a write token. See " +
        "e2e/contributor-trust-boundary-rules.js for each rule and docs/ADMIN-AUTH-SECURITY.md " +
        "for the policy; do not weaken a rule to pass.",
    ).toEqual([]);
  });

  // The workflows that check out and BUILD the PR's code. Each must be called,
  // and only from `pull_request`, where GitHub withholds secrets, OIDC and a
  // write token from a fork. A reusable nothing calls would be unverified.
  test("the reusables that run PR code are reached only from pull_request", () => {
    const prCode = REAL.loaded.filter(
      (w) =>
        w.origin === "platform" &&
        Object.values(w.wf.jobs || {}).some((j) =>
          ((j && j.steps) || []).some(
            (s) => s && /^actions\/checkout@/.test(String(s.uses || "")) && headRefs(s.with && s.with.ref).length,
          ),
        ),
    );
    const names = prCode.map((w) => w.name).sort();
    expect(names, "the preview deploy must be among the PR-code workflows this test found").toContain(
      "deploy-preview.yml",
    );
    for (const w of prCode) {
      expect((REAL.callers.get(w) || []).length, `${w.name} has no caller to judge its trigger by`).toBeGreaterThan(0);
      expect([...REAL.effective.get(w)].sort(), `${w.name} runs PR code`).toEqual(["pull_request"]);
    }
  });

  test("repo-settings.yml requires approval for every outside collaborator", () => {
    const manifest = YAML.parse(fs.readFileSync(path.join(REPO_ROOT, "repo-settings.yml"), "utf8"));
    const repos = Object.keys(manifest.repos || {});
    expect(repos.length).toBeGreaterThan(0);
    for (const repo of repos) {
      const merged = {
        ...(manifest.actions_permissions_defaults || {}),
        ...((manifest.repos[repo] && manifest.repos[repo].actions_permissions) || {}),
      };
      expect(merged.approval_policy, `${repo}: approval_policy`).toBe("all_external_contributors");
    }
  });
});

// ── Rule fixtures: each rule fires on its bad shape and is silent on the good
// one. Every fixture runs through the same lintWorkflows() as the real tree.

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";

// `permissions: null` omits the key.
function wf(on, jobs, permissions = { contents: "read" }) {
  const doc = { name: "fixture", on, jobs };
  if (permissions !== null) doc.permissions = permissions;
  return YAML.stringify(doc);
}
const steps = (...s) => ({ "runs-on": "ubuntu-latest", steps: s });
const checkout = (withMap) => ({ uses: CHECKOUT, with: withMap });

function rulesFor(files, opts = { platformRepo: PLATFORM_REPO }) {
  const list = files.map((f, i) => ({ file: f.name || `fixture-${i}.yml`, name: f.name || `fixture-${i}.yml`, origin: f.origin || "platform", text: f.text }));
  return lintWorkflows(list, opts).offences.map((o) => o.rule);
}
const one = (text) => rulesFor([{ text }]);

const CASES = [
  {
    rule: "no-pull-request-target",
    bad: wf({ pull_request_target: { types: ["opened"] } }, { a: steps({ run: "true" }) }),
    good: wf({ pull_request: { types: ["opened"] } }, { a: steps({ run: "true" }) }),
  },
  {
    rule: "permissions-declared",
    name: "missing on a pull_request workflow",
    bad: wf("pull_request", { a: steps({ run: "true" }) }, null),
    good: wf("pull_request", { a: steps({ run: "true" }) }),
  },
  {
    rule: "permissions-declared",
    name: "write-all on a job",
    bad: wf("push", { a: { ...steps({ run: "true" }), permissions: "write-all" } }),
    good: wf("push", { a: { ...steps({ run: "true" }), permissions: { contents: "write" } } }),
  },
  {
    rule: "privileged-read-only-token",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps({ run: "true" }) }, { contents: "read", "pull-requests": "write" }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: steps({ run: "true" }) }, { contents: "read", "pull-requests": "read" }),
  },
  {
    rule: "no-secrets-inherit",
    bad: wf("pull_request", { a: { uses: "./.github/workflows/r.yml", secrets: "inherit" } }),
    good: wf("pull_request", { a: { uses: "./.github/workflows/r.yml", secrets: { T: "${{ secrets.T }}" } } }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "workflow_run checkout of the triggering run's head",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ ref: "${{ github.event.workflow_run.head_sha }}" })) }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ ref: "${{ inputs.platform_ref }}" })) }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "respelled head_ref (index syntax, case-folded)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ repository: "${{ GITHUB['HEAD_REF'] }}" })) }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ repository: "${{ github.repository }}" })) }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "refs/pull/ literal",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ ref: "refs/pull/1/merge" })) }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ ref: "main" })) }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "head data passed to a reusable",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: { uses: "./.github/workflows/r.yml", with: { ref: "${{ github.event.workflow_run.head_branch }}" } } }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: {
        uses: "./.github/workflows/r.yml",
        with: { n: "${{ (github.event.workflow_run.pull_requests[0] && github.event.workflow_run.pull_requests[0].number) || '' }}" },
      },
    }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "whole payload serialized",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: { uses: "./.github/workflows/r.yml", with: { p: "${{ toJSON(github.event) }}" } } }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: { uses: "./.github/workflows/r.yml", with: { p: "${{ github.event_name }}" } } }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "download-artifact action",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps({ uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" }) }),
    good: wf("pull_request", { a: steps({ uses: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093" }) }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "github-script artifact API (acorn)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "const r = await github.rest.actions.listWorkflowRunArtifacts({ ...context.repo, run_id: context.payload.workflow_run.id });\nreturn r;" },
      }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        // The method name inside a COMMENT and a STRING is not a call.
        with: { script: "// listWorkflowRunArtifacts is not called here\nconst s = 'downloadArtifact';\nawait github.rest.issues.createComment({ ...context.repo, issue_number: 1, body: s });" },
      }),
    }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "github-script request() route (acorn)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "await github.request(`GET /repos/{owner}/{repo}/actions/runs/${context.payload.workflow_run.id}/artifacts`);" },
      }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "await github.request('GET /repos/{owner}/{repo}/issues', context.repo);" },
      }),
    }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "github-script call through a computed member (acorn)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "const m = 'download' + 'Artifact';\nawait github.rest.actions[m]({});" },
      }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        // Computed READS (an index, a key) are data access, not a dynamic call.
        with: { script: "const prs = context.payload.workflow_run.pull_requests;\nconst k = 'number';\ncore.info(String(prs[0] && prs[0][k]));" },
      }),
    }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "issue_comment checkout of refs/pull/<issue number>/head",
    bad: wf("issue_comment", { a: steps(checkout({ ref: "refs/pull/${{ github.event.issue.number }}/head" })) }),
    good: wf("issue_comment", { a: steps(checkout({})) }),
  },
  {
    rule: "privileged-read-only-token",
    name: "issues is privileged",
    bad: wf("issues", { a: steps({ run: "true" }) }, { contents: "read", issues: "write" }),
    good: wf("issues", { a: steps({ run: "true" }) }, { contents: "read", issues: "read" }),
  },
  {
    rule: "privileged-read-only-token",
    name: "discussion_comment is privileged",
    bad: wf("discussion_comment", { a: { ...steps({ run: "true" }), permissions: { discussions: "write" } } }),
    good: wf("pull_request_review_comment", { a: { ...steps({ run: "true" }), permissions: { "pull-requests": "write" } } }),
  },
  {
    rule: "no-secrets-inherit",
    name: "pull_request_review_comment is contributor-reachable",
    bad: wf("pull_request_review_comment", { a: { uses: "./.github/workflows/r.yml", secrets: "inherit" } }),
    good: wf("pull_request_review_comment", { a: { uses: "./.github/workflows/r.yml" } }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "third-party download-artifact action",
    bad: wf({ workflow_run: { workflows: ["x"] } }, { a: steps({ uses: "dawidd6/action-download-artifact@ac66b43f0e6a346234dd65d4d0c8fbb31cb316e5" }) }),
    good: wf({ workflow_run: { workflows: ["x"] } }, { a: steps({ uses: "dawidd6/action-send-mail@ac66b43f0e6a346234dd65d4d0c8fbb31cb316e5" }) }),
  },
  {
    rule: "privileged-no-head-ref",
    name: "action name in another case",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({ uses: "Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", with: { ref: "${{ github.event.workflow_run.head_sha }}" } }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({ uses: "Actions/Checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", with: { ref: "${{ inputs.platform_ref }}" } }),
    }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "github-script destructured artifact method (acorn)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "const { downloadArtifact } = github.rest.actions;\nawait downloadArtifact({ ...context.repo, artifact_id: 1, archive_format: 'zip' });" },
      }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "const { owner, repo } = context.repo;\ncore.info(owner + '/' + repo);" },
      }),
    }),
  },
  {
    rule: "privileged-no-run-artifacts",
    name: "github-script request() with a variable route (acorn)",
    bad: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "const r = 'GET /repos/{owner}/{repo}/actions/' + 'artifacts';\nawait github.request(r, context.repo);" },
      }),
    }),
    good: wf({ workflow_run: { workflows: ["x"] } }, {
      a: steps({
        uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd",
        with: { script: "await github.request(`GET /repos/{owner}/{repo}/pulls`, context.repo);" },
      }),
    }),
  },
  {
    rule: "head-checkout-by-sha",
    bad: wf("pull_request", { a: steps(checkout({ ref: "${{ github.event.pull_request.head.ref }}" })) }),
    good: wf("pull_request", { a: steps(checkout({ ref: "${{ github.event.pull_request.head.sha }}" })) }),
  },
];

test.describe("each trust-boundary rule fires on its bad shape only", () => {
  for (const c of CASES) {
    test(`${c.rule}${c.name ? ` (${c.name})` : ""}`, () => {
      expect(one(c.bad), "the bad fixture must trip this rule").toContain(c.rule);
      expect(one(c.good), "the good fixture must trip nothing").toEqual([]);
    });
  }

  test("a reusable inherits its caller's trigger (the consumer-called path)", () => {
    const reusable = {
      name: "build.yml",
      text: wf("workflow_call", { a: steps(checkout({ ref: "${{ github.event.pull_request.head.sha }}" })) }),
    };
    const caller = (on) => ({
      name: "caller.yml",
      origin: "template",
      text: wf(on, { b: { uses: `${PLATFORM_REPO}/.github/workflows/build.yml@v0.0.1` } }),
    });
    // Under pull_request_target the reusable's head checkout runs fork code with
    // secrets: both the caller's trigger and the reusable's checkout are named.
    const bad = rulesFor([reusable, caller({ pull_request_target: {} })]);
    expect(bad).toContain("no-pull-request-target");
    expect(bad).toContain("privileged-no-head-ref");
    expect(rulesFor([reusable, caller({ pull_request: {} })])).toEqual([]);
    // Consumer mode without the platform tree cannot resolve the reusable: the
    // caller's own trigger is still judged.
    expect(rulesFor([caller({ pull_request_target: {} })], {})).toEqual(["no-pull-request-target"]);
  });

  test("an issue_comment ChatOps deploy is caught on every count", () => {
    const rules = one(
      wf(
        "issue_comment",
        {
          build: steps(checkout({ ref: "refs/pull/${{ github.event.issue.number }}/head" })),
          deploy: { uses: "./.github/workflows/r.yml", secrets: "inherit" },
        },
        { contents: "write" },
      ),
    );
    expect(rules).toContain("privileged-read-only-token");
    expect(rules).toContain("no-secrets-inherit");
    expect(rules).toContain("privileged-no-head-ref");
  });

  test("an unreadable expression and an unparseable script are denied", () => {
    expect(one(wf({ workflow_run: { workflows: ["x"] } }, { a: steps(checkout({ ref: "${{ github.event['" })) }))).toContain(
      "privileged-no-head-ref",
    );
    expect(
      one(
        wf({ workflow_run: { workflows: ["x"] } }, {
          a: steps({ uses: "actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd", with: { script: "const = ;" } }),
        }),
      ),
    ).toContain("privileged-no-run-artifacts");
  });
});
