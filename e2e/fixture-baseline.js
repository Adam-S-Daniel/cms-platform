/*
 * Shared "force the fixture to a known baseline" helpers for the CMS
 * publish-loop / mutation specs.
 *
 * Why this module exists (issue #1053)
 * ------------------------------------
 * The prod-mutation and media-roundtrip specs used to derive their
 * cleanup/baseline text via
 *
 *     function buildBaselineFileText() {
 *       return fs.readFileSync(FIXTURE_ABS, "utf8");
 *     }
 *
 * i.e. they TRUSTED whatever `published:` value was checked in. The
 * canary fixtures are checked in `published: true`, so every cleanup
 * re-wrote `published: true`, the next run's guard saw `published:
 * true`, `test.fixme()`'d into a GREEN (skipped) job, and the loop
 * never ran — for ~10 days with zero signal. It was a fixed point,
 * not self-healing.
 *
 * The fix is to NEVER trust the on-disk `published:` value: always
 * force it to `false` when constructing the baseline. Several specs
 * had each grown their own copy of this logic (`sanitizeToBaseline`,
 * `forcePublishedFalse`, `readPublishedFlag`); this module is the one
 * shared implementation so a future spec can't reintroduce the
 * trust-the-file bug by copy-paste drift.
 *
 * #1771 step 4 retired the two persistent prod `_posts/` canaries
 * (`2099-01-01-e2e-mutation-canary.md` / `2099-01-03-e2e-media-roundtrip.md`)
 * in favour of EPHEMERAL born-published, hard-deleted per-run posts —
 * resting state is absence/404 (see e2e/prod-mutate-fixture.js). With no
 * persistent prod fixture left to distrust, the `PROD_FIXTURES` list,
 * `reconstructBaseline`/`PROD_FIXTURES_CANON`, and the diff-aware
 * `shouldEnforceBaseline`/`baselineAssertionApplies`/`parseTouchedFixtures`
 * baseline-gating plumbing all retired with them. What remains is the
 * SMALL surface the still-persistent specs need: `forcePublishedFalse` /
 * `sanitizeToBaseline` (the toggle-only `cms-unpublish-republish*` +
 * `cms-publish-loop-prod-mutate-preview` specs, which write the fixture
 * back to a PR head branch — never main), plus `readPublishedFlag` and
 * the `loudBail` / `isScheduledMustRun` loud-skip doctrine.
 *
 * Pure Node — deliberately NO `require("./base")`. `loudBail` takes
 * the caller's Playwright `test` object as an argument so this module
 * stays a plain, unit-testable library (see fixture-baseline.test.js).
 */

// Parse the front-matter `published:` flag from a file's text. Matches
// `published: true|false` on its own line, tolerating surrounding
// whitespace and single/double quoting. Returns true | false, or null
// when there is no parseable line.
function readPublishedFlag(text) {
  const m = text.match(/^published:\s*(true|false|"true"|"false"|'true'|'false')\s*$/m);
  if (!m) return null;
  return m[1].replace(/['"]/g, "") === "true";
}

// Split "<frontMatter>\n---\n<body>" at the closing `---` delimiter.
// `frontMatter` excludes the delimiter; `body` includes the leading
// "\n---\n" (byte-identical to the slicing the per-spec copies did).
// Throws a descriptive, fixture-named error if the closing delimiter
// is missing, so a malformed fixture fails loudly instead of silently
// producing junk baseline text.
function splitFrontMatter(fileText, fixturePath) {
  const fmEnd = fileText.indexOf("\n---\n", 4);
  if (fmEnd < 0) {
    throw new Error(`Fixture ${fixturePath} is missing its closing front-matter delimiter.`);
  }
  return {
    frontMatter: fileText.slice(0, fmEnd), // up to (not incl) "\n---\n"
    body: fileText.slice(fmEnd), // includes leading "\n---\n"
  };
}

// Internal: return the front matter with `published:` forced to
// `false` (replacing an existing line, or appending one if absent).
function frontMatterPublishedFalse(frontMatter) {
  return /^published:\s*.*$/m.test(frontMatter)
    ? frontMatter.replace(/^published:\s*.*$/m, "published: false")
    : `${frontMatter}\npublished: false`;
}

// Force `published: false` in the front matter, leaving the body and
// the rest of the front matter byte-for-byte untouched. Use this when
// the body IS meaningful and should flow through from the checked-in
// fixture (prod-mutate / media-roundtrip / the toggle-only specs): a
// documentation-body edit to the committed fixture still reaches the
// cleanup commit automatically, but the dangerous `published:` value
// can never be trusted from disk again.
function forcePublishedFalse(fileText, fixturePath) {
  const { frontMatter, body } = splitFrontMatter(fileText, fixturePath);
  return `${frontMatterPublishedFalse(frontMatter)}${body}`;
}

// Force `published: false` AND replace the body with a canonical,
// marker-free baseline. Use this when the body itself is churned by
// the spec and a prior crashed run may have left a run-marker in it
// (the preview prod-mutate parity spec, which writes the fixture back
// to a PR head branch — never main). `baselineBody` is everything that
// should follow the closing front-matter `---`.
function sanitizeToBaseline(fileText, fixturePath, baselineBody) {
  const { frontMatter } = splitFrontMatter(fileText, fixturePath);
  return `${frontMatterPublishedFalse(frontMatter)}\n---\n${baselineBody}`;
}

// True when this process is a scheduled / manually-dispatched CI run
// that is SUPPOSED to execute the loop for real. In that context a
// precondition bail must be a LOUD red failure, never a green
// `test.fixme`/`skip` (#1053 acceptance criterion: "a skipped/
// precondition-unmet scheduled run is a failed (visible) check, never
// a green no-op"). `pull_request` runs and local dev are intentionally
// NOT must-run: a PR author shouldn't be blocked by a fixture a prior
// run left dirty, and local dev legitimately skips these prod loops.
function isScheduledMustRun() {
  const ev = process.env.GITHUB_EVENT_NAME || "";
  return ev === "schedule" || ev === "workflow_dispatch";
}

// Bail on an unmet precondition. In a must-run scheduled/dispatch CI
// context this THROWS (the job goes red — visible). Everywhere else
// it `test.fixme()`s (green skip — local dev / PR iteration), exactly
// as the per-spec guards did before. Callers keep their trailing
// `return;` so the non-throw path still exits the test body.
function loudBail(test, message) {
  if (isScheduledMustRun()) {
    throw new Error(
      `[#1053 loud-skip guard] precondition unmet on a scheduled/` +
        `workflow_dispatch run — failing the job instead of silently ` +
        `skipping into a green check: ${message}`,
    );
  }
  test.fixme(true, message);
}

module.exports = {
  readPublishedFlag,
  splitFrontMatter,
  forcePublishedFalse,
  sanitizeToBaseline,
  isScheduledMustRun,
  loudBail,
};
