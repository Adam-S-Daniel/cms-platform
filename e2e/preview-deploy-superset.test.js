// @lane: local — pure-fs drift-lock for the "probe ⊆ deploy" invariant (#1815)
//
// THE INVARIANT: every input that makes a CI consumer PROBE the per-PR
// preview (preview-pr<N>.adamdaniel.ai) must also be an input that
// deploy-preview.yml actually DEPLOYS for. Formally: probe ⊆ deploy.
//
// WHY IT EXISTS: two REQUIRED checks probe the preview and HARD-FAIL if
// it's unreachable —
//   - `parity`        (.github/workflows/parity-preview.yml) runs the
//                      @parity-preview specs against the preview;
//   - `preview-media` (.github/workflows/preview-media.yml)   runs a
//                      media gate against the preview.
// deploy-preview.yml — the workflow that BUILDS the preview — uses a
// workflow-level `paths-ignore` that includes `e2e/**`. A PR that
// touches ONLY paths-ignored files (the real incident: a PR editing
// only e2e/sitemap.spec.js) deploys NO preview. If a consumer still
// decides that PR is "salient" and probes a preview that never
// existed, it hard-fails after a ~20-min timeout and blocks the merge.
//
// This test locks both consumers' salience logic to affectsDeployedPreview
// (derived from deploy-preview.yml's own paths-ignore, so it can't
// drift). If anyone re-adds a probe trigger for a non-deployed path,
// this fails LOUD on every PR until it's removed.

const { test, expect } = require("./base");
const {
  selectParityPreviewSpecs,
  affectsDeployedPreview,
  RENDER_FANOUT_PATTERNS,
  SPEC_RULES,
  PARITY_PREVIEW_SPECS,
} = require("./select-specs");
const { readWorkflow } = require("./workflow-yaml-utils");

// One representative repo path for each RENDER_FANOUT pattern, chosen so
// the pattern's RegExp matches it. These are the render-fanout inputs
// that make selectParityPreviewSpecs fan out to every parity spec.
const RENDER_FANOUT_SAMPLE = [
  "_layouts/post.html", // /^_layouts\//
  "_includes/head.html", // /^_includes\//
  "_config.yml", // /^_config\.yml$/
  "assets/css/main.css", // /^assets\/css\//
  "_plugins/auto_tag_pages.rb", // /^_plugins\//
  "Gemfile.lock", // /^Gemfile/
  "feed.xml", // /^feed\.xml$/
];

test.describe("preview-deploy-superset — probe ⊆ deploy invariant (#1815)", () => {
  // Sanity: the representative sample actually exercises every
  // RENDER_FANOUT pattern (so a future pattern addition can't sneak
  // past this lint by being unrepresented).
  test("RENDER_FANOUT_SAMPLE covers every RENDER_FANOUT_PATTERN", () => {
    for (const rx of RENDER_FANOUT_PATTERNS) {
      expect(
        RENDER_FANOUT_SAMPLE.some((f) => rx.test(f)),
        `RENDER_FANOUT_SAMPLE has no representative path for ${rx}`,
      ).toBe(true);
    }
  });

  // (a) parity: nothing can force a parity-preview probe unless
  // deploy-preview deploys for it. Enumerate every plausible
  // probe-trigger (render-fanout reps + every SPEC_RULES path for the 5
  // parity specs); for each that ACTUALLY selects ≥1 parity spec on its
  // own, assert affectsDeployedPreview === true.
  test("(a) every input that selects a parity-preview spec affects the deployed preview", () => {
    // Build the candidate set: render-fanout reps + a representative
    // path for each SPEC_RULES RegExp of each parity-preview spec.
    const candidates = new Set(RENDER_FANOUT_SAMPLE);
    for (const spec of PARITY_PREVIEW_SPECS) {
      for (const rx of SPEC_RULES[spec] || []) {
        candidates.add(representativePath(rx));
      }
    }

    for (const file of candidates) {
      const selects = selectParityPreviewSpecs([file]).length > 0;
      if (selects) {
        expect(
          affectsDeployedPreview(file),
          `${file} forces a parity-preview probe but deploy-preview.yml's ` +
            `paths-ignore would NOT deploy a preview for it (probe ⊄ deploy). ` +
            `Either drop it from the parity selector or stop path-ignoring it.`,
        ).toBe(true);
      }
    }
  });

  // (b) preview-media: every path anchor in the salient grep alternation
  // must affect the deployed preview. This locks the shell grep (which
  // is not JS and so can't import affectsDeployedPreview) to the same
  // invariant.
  test("(b) every preview-media salient grep anchor affects the deployed preview", () => {
    const anchors = previewMediaSalientAnchors();
    expect(
      anchors.length,
      "expected to parse ≥1 salient anchor from preview-media.yml",
    ).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const file = representativePathFromAnchor(anchor);
      expect(
        affectsDeployedPreview(file),
        `preview-media.yml's salient grep anchor "${anchor}" (sample path ` +
          `"${file}") makes the media gate probe the preview, but ` +
          `deploy-preview.yml would NOT deploy for it (probe ⊄ deploy). ` +
          `Remove the anchor — a test-only file deploys no preview; the ` +
          `spec still runs in the e2e matrix.`,
      ).toBe(true);
    }
  });
});

// Derive a concrete repo path that a SPEC_RULES anchored RegExp matches.
// SPEC_RULES patterns are all `^`-anchored; many use `(a|b)` groups or
// trailing `$`. We synthesise a path by stripping regex syntax into a
// plausible filename. Falls back to a directory-style sample for
// directory-prefix patterns.
function representativePath(rx) {
  const src = rx.source;
  // Directory-prefix pattern like /^_posts\// → a file under that dir.
  const dirMatch = src.match(/^\^([A-Za-z0-9_./-]+)\\\/$/);
  if (dirMatch) {
    return `${dirMatch[1].replace(/\\/g, "")}/sample.txt`;
  }
  // Otherwise build the simplest matching string: take the first
  // alternative of any group, unescape, drop anchors.
  let s = src;
  s = s.replace(/^\^/, "").replace(/\$$/, "");
  // Replace `(a|b|c)` with `a` (first alternative).
  s = s.replace(/\(([^)]*)\)/g, (_, group) => {
    const opt = group.replace(/\?:/g, "").split("|")[0];
    return opt;
  });
  // `(-local)?` style optional groups already collapsed above; remove a
  // stray trailing `?`.
  s = s.replace(/\?/g, "");
  // Unescape backslash-escaped regex metacharacters (\. \/ etc.).
  s = s.replace(/\\(.)/g, "$1");
  // A trailing `/` (directory pattern that wasn't matched above) → file.
  if (s.endsWith("/")) s += "sample.txt";
  return s;
}

// Parse the salient grep alternation out of preview-media.yml's
// "Detect media-salient changes" step. Returns the list of `|`-split
// anchor fragments (e.g. `assets/images/uploads/`, `_config\.yml$`).
function previewMediaSalientAnchors() {
  const yaml = readWorkflow("preview-media.yml");
  // Match the single-quoted ERE inside the grep: '^(...)' .
  const m = yaml.match(/grep -Eq[^\n]*\n\s*'\^\(([^']+)\)'/);
  expect(m, "preview-media.yml must contain the salient grep alternation '^( ... )'").toBeTruthy();
  return m[1].split("|").map((s) => s.trim());
}

// Turn one grep anchor fragment (ERE) into a concrete repo path.
// Anchors are either a directory prefix (`assets/images/uploads/`) or a
// `$`-anchored file pattern with `\.` escapes and optional `(a|b)`
// groups.
function representativePathFromAnchor(anchor) {
  let s = anchor.replace(/\$$/, "");
  // Collapse `(a|b)` / `(-local)?` groups to the first alternative.
  s = s.replace(/\(([^)]*)\)\??/g, (_, group) => group.replace(/\?:/g, "").split("|")[0]);
  s = s.replace(/\\(.)/g, "$1"); // unescape \. \/ etc.
  if (s.endsWith("/")) s += "sample.png";
  return s;
}
