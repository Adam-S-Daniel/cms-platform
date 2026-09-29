// @lane: local — pure-Node unit tests for scripts/reconcile-caller-secrets.js
//
// WHY THIS EXISTS. platform-bump moved pins, seeded new callers, retired old
// ones and reconciled `required_contexts` — but never a thin caller's
// `secrets:` map. v0.1.113 (#467) added
//     secrets:
//       app_private_key: ${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
// to examples/site/.github/workflows/dependabot-rearm-sweep.yml; neither
// consumer received it, and both v0.1.114 bump PRs (adamdaniel.ai#3891,
// jodidaniel.com#281) failed `pin-consistency / pin-consistency` with
//     workflow-content: DRIFT ... job rearm secrets: map (canonical {...} vs null)
// until the map was hand-added. check-platform-pin-consistency.js compares the
// map WHOLE and SYMMETRICALLY against the template at the consumer's own
// platform_ref, so the reconcile has to ride the bump commit.
//
// These tests drive the reconciler against a synthetic consumer, then run the
// REAL pin-consistency checker over the result — "passes pin-consistency alone"
// is the acceptance criterion, so it is what gets asserted.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const RECONCILE = path.resolve(__dirname, "../scripts/reconcile-caller-secrets.js");
const CHECKER = path.resolve(__dirname, "../scripts/check-platform-pin-consistency.js");
const SENTINEL_REL = "assets/images/uploads/e2e-preview-media-probe.png";
const SENTINEL_SRC = path.join(__dirname, "fixtures", "tiny-pixel.png");
const V = "v0.1.114";
const OWNER = "Adam-S-Daniel";
const REPO = "cms-platform";
const SLUG = `${OWNER}/${REPO}`;

// The canonical rearm-sweep caller as it shipped in v0.1.113/v0.1.114 — the
// incident's template, verbatim in shape.
const CANON_REARM = `name: Dependabot re-arm sweep
on:
  schedule:
    - cron: '17 8 * * *'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  rearm:
    uses: ${SLUG}/.github/workflows/dependabot-rearm-sweep.yml@${V}
    with:
      dry_run: false
      platform_ref: ${V}
    secrets:
      # Optional. The CMS automation App's private key.
      app_private_key: \${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}
`;

// The consumer as both sites had it: no secrets map, plus site-owned tuning
// (a different cron, a site comment) that the reconcile must not touch.
const CONSUMER_REARM = `name: Dependabot re-arm sweep
on:
  schedule:
    # Site-tuned: runs after our nightly deploy.
    - cron: '42 9 * * *'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  rearm:
    uses: ${SLUG}/.github/workflows/dependabot-rearm-sweep.yml@${V}
    with:
      # Site note: keep the dry run off.
      dry_run: false
      platform_ref: ${V}
`;

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// A consumer + canonical dir holding the given { name: [canonical, consumer] }.
// A null side means "that side has no such file".
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cms-secrets-consumer-"));
  const canon = fs.mkdtempSync(path.join(os.tmpdir(), "cms-secrets-canon-"));
  write(root, "platform.lock", `platform_repo: ${SLUG}\nplatform_ref: ${V}\n`);
  write(root, SENTINEL_REL, fs.readFileSync(SENTINEL_SRC));
  for (const [name, [c, s]] of Object.entries(files)) {
    if (c !== null) write(canon, name, c);
    if (s !== null) write(root, `.github/workflows/${name}`, s);
  }
  return { root, canon, wf: (name) => path.join(root, ".github/workflows", name) };
}

function reconcile({ root, canon }) {
  return spawnSync(
    process.execPath,
    [RECONCILE, "--canonical-dir", canon, "--workflows-dir", path.join(root, ".github/workflows")],
    { encoding: "utf8" },
  );
}

function checker({ root, canon }) {
  return spawnSync(
    process.execPath,
    [CHECKER, "--root", root, "--owner", OWNER, "--repo", REPO, "--canonical-workflows", canon, "--require-canonical"],
    { encoding: "utf8" },
  );
}

const out = (r) => `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`;

test.describe("reconcile-caller-secrets.js — the v0.1.113 incident", () => {
  test("a caller missing a secrets key the template gained is reconciled, and pin-consistency then passes", () => {
    const fx = fixture({ "dependabot-rearm-sweep.yml": [CANON_REARM, CONSUMER_REARM] });

    // RED baseline: exactly the incident's failure.
    const before = checker(fx);
    expect(before.status, out(before)).not.toBe(0);
    expect(before.stderr).toMatch(/job `rearm` secrets: map \(canonical .*app_private_key.* vs null\)/);

    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/^UPDATED dependabot-rearm-sweep\.yml job rearm: added app_private_key$/m);

    const after = checker(fx);
    expect(after.status, out(after)).toBe(0);

    // The consumer's own tuning and comments survive; the template's comment
    // for the new key comes with it.
    const text = fs.readFileSync(fx.wf("dependabot-rearm-sweep.yml"), "utf8");
    expect(text).toContain("    # Site-tuned: runs after our nightly deploy.\n    - cron: '42 9 * * *'\n");
    expect(text).toContain("      # Site note: keep the dry run off.\n");
    expect(text).toContain(
      "    secrets:\n      # Optional. The CMS automation App's private key.\n" +
        "      app_private_key: ${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}\n",
    );
    // Only lines were ADDED — every original line is still there, in order.
    expect(text.startsWith(CONSUMER_REARM)).toBe(true);
  });

  test("running it twice is a no-op the second time", () => {
    const fx = fixture({ "dependabot-rearm-sweep.yml": [CANON_REARM, CONSUMER_REARM] });
    expect(reconcile(fx).status).toBe(0);
    const once = fs.readFileSync(fx.wf("dependabot-rearm-sweep.yml"), "utf8");
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).not.toMatch(/^UPDATED/m);
    expect(fs.readFileSync(fx.wf("dependabot-rearm-sweep.yml"), "utf8")).toBe(once);
  });
});

test.describe("reconcile-caller-secrets.js — add, drop, change, and leave alone", () => {
  const caller = (secretsBlock) => `name: Bump
on:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@${V}
${secretsBlock}`;

  test("a key the template DROPPED is removed, the kept key and its site comment stay byte-identical", () => {
    // The v0.1.103 shape: `gh_token` left the reusable's interface.
    const canonical = caller(
      "    secrets:\n      app_private_key: ${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}\n",
    );
    const consumer = caller(
      "    secrets:\n" +
        "      # Site: the App key lives in the org secret store.\n" +
        "      app_private_key: ${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}\n" +
        "      # Old PAT fallback.\n" +
        "      gh_token: ${{ secrets.CMS_PLATFORM_PAT }}\n",
    );
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/^UPDATED platform-bump\.yml job bump: removed gh_token$/m);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(
      caller(
        "    secrets:\n" +
          "      # Site: the App key lives in the org secret store.\n" +
          "      app_private_key: ${{ secrets.CMS_AUTOMATION_APP_PRIVATE_KEY }}\n",
      ),
    );
    expect(checker(fx).status, out(checker(fx))).toBe(0);
  });

  test("a key whose value the template CHANGED takes the template's value", () => {
    const canonical = caller("    secrets:\n      token: ${{ secrets.NEW_NAME }}\n");
    const consumer = caller("    secrets:\n      token: ${{ secrets.OLD_NAME }}\n");
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).toMatch(/^UPDATED platform-bump\.yml job bump: changed token$/m);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(canonical);
  });

  test("a whole secrets map the template no longer has is removed", () => {
    const canonical = caller("");
    const consumer = caller("    secrets:\n      gh_token: ${{ secrets.CMS_PLATFORM_PAT }}\n");
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(canonical);
  });

  test("`secrets: inherit` is replaced by the template's explicit map", () => {
    const canonical = caller("    secrets:\n      app_private_key: ${{ secrets.K }}\n");
    const consumer = caller("    secrets: inherit\n");
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    expect(reconcile(fx).status).toBe(0);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(canonical);
  });

  test("a new map is inserted after the key it follows in the template, not dumped at the end", () => {
    const canonical = `jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@${V}
    secrets:
      k: \${{ secrets.K }}
    with:
      platform_ref: ${V}
`;
    const consumer = `jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@${V}
    with:
      platform_ref: ${V}
`;
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    expect(reconcile(fx).status).toBe(0);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(canonical);
  });

  test("the consumer's indentation wins over the template's", () => {
    const canonical = `jobs:
  bump:
    uses: ${SLUG}/.github/workflows/platform-bump.yml@${V}
    secrets:
      k: \${{ secrets.K }}
`;
    const consumer = `jobs:
    bump:
        uses: ${SLUG}/.github/workflows/platform-bump.yml@${V}
`;
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    expect(reconcile(fx).status).toBe(0);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(
      consumer + "        secrets:\n            k: ${{ secrets.K }}\n",
    );
  });

  test("a matching caller, a site-authored workflow, and a caller the consumer lacks are all untouched", () => {
    const same = caller("    secrets:\n      k: ${{ secrets.K }}\n");
    const siteOwn = "name: Mine\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n";
    const fx = fixture({
      "platform-bump.yml": [same, same],
      "site-own.yml": [null, siteOwn],
      "seeded-elsewhere.yml": [same, null],
    });
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(0);
    expect(r.stdout).not.toMatch(/^UPDATED/m);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(same);
    expect(fs.readFileSync(fx.wf("site-own.yml"), "utf8")).toBe(siteOwn);
    expect(fs.existsSync(fx.wf("seeded-elsewhere.yml"))).toBe(false);
  });

  test("a flow-style secrets map is swapped for the template's block map", () => {
    const canonical = caller("    secrets:\n      a: ${{ secrets.A }}\n      b: ${{ secrets.B }}\n");
    const consumer = caller("    secrets: { a: '${{ secrets.A }}' }\n");
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    expect(reconcile(fx).status).toBe(0);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(canonical);
  });

  test("a flow-style JOB it cannot splice safely is reported MANUAL and left unchanged", () => {
    const canonical = caller("    secrets:\n      a: ${{ secrets.A }}\n");
    const consumer = `jobs:\n  bump: { uses: '${SLUG}/.github/workflows/platform-bump.yml@${V}' }\n`;
    const fx = fixture({ "platform-bump.yml": [canonical, consumer] });
    const r = reconcile(fx);
    expect(r.status, out(r)).toBe(3);
    expect(r.stdout).toMatch(/^MANUAL platform-bump\.yml: job bump is not a block map — left unchanged$/m);
    expect(fs.readFileSync(fx.wf("platform-bump.yml"), "utf8")).toBe(consumer);
  });
});

test.describe("platform-bump reusable — wires the secrets reconcile into the bump commit", () => {
  const run = parseYaml(readWorkflow("platform-bump.yml")).jobs.bump.steps.find((s) => s.id === "bump").run;

  test("fetches the reconciler and the checker it reuses at the NEW ref, with the yaml parser", () => {
    expect(run).toMatch(/contents\/scripts\/reconcile-caller-secrets\.js\?ref=\$LATEST/);
    expect(run).toMatch(/contents\/scripts\/check-platform-pin-consistency\.js\?ref=\$LATEST/);
    expect(run).toMatch(/npm install --prefix "\$SECRETS_TOOLS" --no-save --no-package-lock yaml@2\.9\.1/);
  });

  test("reads each canonical caller at $LATEST and runs before the commit", () => {
    expect(run).toMatch(/examples\/site\/\.github\/workflows\/\$name\?ref=\$LATEST/);
    const at = run.indexOf('node "$SECRETS_TOOLS/scripts/reconcile-caller-secrets.js"');
    expect(at, "the bump step must run the reconciler").toBeGreaterThan(-1);
    expect(at).toBeLessThan(run.indexOf("git commit"));
  });

  test("every outcome reaches the PR body", () => {
    expect(run).toMatch(/SECRETS_NOTE=/);
    expect(run).toMatch(/SEED_NOTE="\$\{SEED_NOTE\}\$\{CONTEXT_NOTE\}\$\{SECRETS_NOTE\}"/);
  });
});
