// @lane: local — pure-fs drift-lock for "a selected spec is a RUNNABLE spec".
//
// THE INVARIANT: no spec in select-specs.js's PARITY_PREVIEW_SPECS may be
// testIgnore'd by playwright.config.js on a CONSUMER lane.
//
// WHY IT EXISTS: parity-preview.yml is the ONLY caller of the @parity-preview
// selector, it runs exclusively on consumers, and it sets
// `SITE_ROOT: ${{ github.workspace }}` — which is precisely the flag that turns
// on the config's PLATFORM_META_SPECS `testIgnore`. So a spec named in BOTH
// lists is unrunnable by the one workflow that can select it. That is not
// merely dead coverage: the reusable passes the selected paths to
// `npx playwright test <paths>`, and when EVERY selected path is ignored
// Playwright collects nothing and exits 1 —
//
//     Error: No tests found.
//     Make sure that arguments are regular expressions matching test files.
//
// — which reds `parity / parity`, a REQUIRED context on both consumers. The
// selection narrows to one spec exactly when a PR's only preview-salient change
// is under `admin/**`, so the overlap stayed invisible until an admin-only PR
// arrived (jodidaniel.com#247, 2026-09-04: admin-bundle-parity.spec.js was in
// both lists, and it was the only spec selected).
//
// It asks the EFFECTIVE question — "would the consumer lane ignore this?" — by
// evaluating the real config in CONSUMER mode, rather than diffing two arrays.
// The config derives its ignore regex from PLATFORM_META_SPECS at require time,
// so an array comparison would go blind the moment that derivation changes.
// The evaluation happens in a CHILD PROCESS because CONSUMER mode is keyed off
// `process.env.SITE_ROOT`: setting it here would leak into every other test
// sharing this worker.

const { test, expect } = require("./base");
const path = require("path");
const { execFileSync } = require("child_process");
const { PARITY_PREVIEW_SPECS } = require("./select-specs");

const REPO_ROOT = path.join(__dirname, "..");

// Returns the PARITY_PREVIEW_SPECS entries the CONSUMER-mode config ignores.
function ignoredOnConsumerLane() {
  const probe = [
    "const cfg = require(process.argv[1]);",
    "const { PARITY_PREVIEW_SPECS } = require(process.argv[2]);",
    "const ignores = [].concat(cfg.testIgnore || []);",
    "const hit = PARITY_PREVIEW_SPECS.filter((s) => ignores.some((re) => re.test(s)));",
    "process.stdout.write(JSON.stringify({ ignored: hit, total: PARITY_PREVIEW_SPECS.length }));",
  ].join("\n");

  const out = execFileSync(
    process.execPath,
    [
      "-e",
      probe,
      path.join(__dirname, "playwright.config.js"),
      path.join(__dirname, "select-specs.js"),
    ],
    // SITE_ROOT is what selects the CONSUMER branch of `testIgnore`; point it
    // at a real directory, as the reusable does with github.workspace.
    { env: { ...process.env, SITE_ROOT: REPO_ROOT }, encoding: "utf8" },
  );
  return JSON.parse(out);
}

test("@parity-preview selector never names a spec the CONSUMER lane testIgnores", () => {
  const { ignored, total } = ignoredOnConsumerLane();

  // Guard the denominator: an empty selector list would make the assertion
  // below pass over nothing at all.
  expect(total, "PARITY_PREVIEW_SPECS is empty — the check below proves nothing").toBeGreaterThan(
    0,
  );
  expect(total).toBe(PARITY_PREVIEW_SPECS.length);

  expect(
    ignored,
    "These specs are selectable by parity-preview.yml but testIgnore'd on every " +
      "consumer lane, so selecting only them makes Playwright exit 1 with " +
      '"No tests found" and reds the REQUIRED `parity / parity`. Either drop them ' +
      "from PARITY_PREVIEW_SPECS in select-specs.js, or remove them from " +
      "PLATFORM_META_SPECS in playwright.config.js:\n  " +
      ignored.join("\n  "),
  ).toEqual([]);
});
