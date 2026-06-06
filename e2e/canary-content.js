/*
 * Canary fixture descriptors. The publish-loop tests use these to drive
 * admin-side edits and then assert the change appears at the public URL.
 *
 * Every entry has:
 *   - `id`             — matches the `canary_id:` front-matter, used as a
 *                        DOM attribute so tests don't need to grep markup
 *   - `slug`           — the URL slug; tests can derive both the CMS
 *                        navigation path and the public URL from this
 *   - `path`           — the source-file path under `_e2e/`
 *   - `cmsCollection`  — Decap collection name (`e2e`, since canaries live
 *                        in their own system collection)
 *   - `publicPath`     — root-relative URL the public site renders at
 *   - `baseline`       — the title-line baseline body sentence; the
 *                        publish-loop spec asserts this string is live on
 *                        the public URL after cleanup. Drift in this
 *                        single sentence is what the daily canary probe
 *                        watches for.
 *   - `baselineBody`   — the FULL canonical body the cleanup step writes
 *                        back (title sentence + explanatory paragraphs +
 *                        the "no test in progress" footer). The UI
 *                        cleanup leg types this verbatim into the body
 *                        textarea (see admin/config.yml: `widget: text`
 *                        on the e2e collection body field — using
 *                        `widget: markdown` would round-trip every soft
 *                        line wrap into a paragraph break, producing
 *                        perpetually-open conflicting cms/e2e/* PRs;
 *                        see PR #882 for the case study).
 *
 * The baseline strings here MUST stay in sync with the body text in the
 * checked-in `_e2e/canary-*.md` files. The unit test
 * `e2e/canary-content.test.js` enforces that drift is caught at CI time.
 */
const path = require("node:path");
const fs = require("node:fs");

// SITE_ROOT-aware: the checked-in `_e2e/canary-*.md` fixtures live at the
// CONSUMING site's root. In a consumer the harness sits at the site root so
// `__dirname/..` IS the site; SITE_ROOT (exported by the e2e reusable, or
// pointed at a fixture by the #33 meta-test) is the explicit, portable form.
// They agree in the platform self-CI (SITE_ROOT unset → `__dirname/..`).
const REPO_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

function buildBaselineBody(baselineTitle) {
  return (
    `${baselineTitle}\n\n` +
    "This URL exists so the automated end-to-end publish-loop tests have a stable\n" +
    "target to assert against on both preview-pr<N>.adamdaniel.ai and\n" +
    "adamdaniel.ai. The body is replaced during a test run and reset to this\n" +
    "baseline in cleanup, so the public URL always renders innocuous content\n" +
    "between runs.\n\n" +
    "If this is the only thing you can see, no test is currently in progress."
  );
}

function makeCanary(spec) {
  return {
    ...spec,
    baselineBody: buildBaselineBody(spec.baseline),
  };
}

const CANARIES = [
  makeCanary({
    id: "post",
    slug: "canary-post",
    path: "_e2e/canary-post.md",
    cmsCollection: "e2e",
    publicPath: "/e2e/canary-post/",
    baseline: "Adam Daniel — E2E canary post (do not edit by hand).",
  }),
  makeCanary({
    id: "page",
    slug: "canary-page",
    path: "_e2e/canary-page.md",
    cmsCollection: "e2e",
    publicPath: "/e2e/canary-page/",
    baseline: "Adam Daniel — E2E canary page (do not edit by hand).",
  }),
  makeCanary({
    id: "project",
    slug: "canary-project",
    path: "_e2e/canary-project.md",
    cmsCollection: "e2e",
    publicPath: "/e2e/canary-project/",
    baseline: "Adam Daniel — E2E canary project (do not edit by hand).",
  }),
];

function findCanary(idOrSlug) {
  const c = CANARIES.find((x) => x.id === idOrSlug || x.slug === idOrSlug);
  if (!c) throw new Error(`Unknown canary: ${idOrSlug}`);
  return c;
}

function readCanarySource(canary) {
  return fs.readFileSync(path.join(REPO_ROOT, canary.path), "utf8");
}

function makeMarker(canaryId, runId = Date.now()) {
  return `e2e-publish-loop:${canaryId}:${runId}`;
}

// A single in-flight publish-loop marker line, e.g. `e2e-publish-loop:post:1780…`.
// Lexical (anchored to a whole line) — the body byte-lock + self-heal both key
// off this ONE pattern so they can never drift apart.
const MARKER_LINE_RE = /e2e-publish-loop:[a-z][a-z-]*:\d+/;

// Remove AT MOST ONE in-flight marker (and the blank lines the publish-loop
// wraps it in) from a canary body, returning the underlying baseline body.
// The host loop appends `\n\n${makeMarker(id,runId)}\n` typed at a line end,
// so the marker lands either mid-body (wrapped `\n\n<marker>\n\n`) or
// trailing (`\n\n<marker>`); strip exactly one such occurrence. A SECOND
// marker (the multi-orphan pathology, #1861) or any other drift survives, so
// the caller's strict baseline compare still fails loud on real corruption.
// Input/output are leading/trailing-newline-trimmed.
function stripInFlightMarker(body) {
  // Tolerate EXACTLY ONE marker. Zero → already baseline; two or more → the
  // multi-orphan pathology (#1861), which must fail the caller's compare, so
  // leave the body untouched.
  const found = body.match(/e2e-publish-loop:[a-z][a-z-]*:\d+/g) || [];
  if (found.length !== 1) return body;
  return body
    .replace(/\n\ne2e-publish-loop:[a-z][a-z-]*:\d+\n\n/, "\n") // mid-body splice → rejoin
    .replace(/\n\ne2e-publish-loop:[a-z][a-z-]*:\d+$/, "") //        trailing append → drop
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

module.exports = {
  CANARIES,
  REPO_ROOT,
  findCanary,
  makeMarker,
  MARKER_LINE_RE,
  stripInFlightMarker,
  readCanarySource,
  buildBaselineBody,
};
