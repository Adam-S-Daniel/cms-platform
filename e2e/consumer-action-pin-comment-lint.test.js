// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library,
// never a regex over source) asserting that no `uses:` pin a CONSUMER actually
// ships carries a trailing VERSION comment.
//
// WHY THIS EXISTS — THE HALF ITS PLATFORM SIBLING CANNOT COVER
// ------------------------------------------------------------
// `e2e/action-pin-comment-lint.test.js` enforces the same invariant on the
// platform tree and on the canonical thin-caller TEMPLATES under this repo's
// examples directory. It is registered in playwright.config.js's
// PLATFORM_META_SPECS — it has to be, because it asserts against the platform's
// own workflow definitions — and playwright.config.js testIgnores every
// registered name on a CONSUMER lane. So the sibling can never run on
// adamdaniel.ai or jodidaniel.com, which between them carry the majority of the
// fleet's pinned `uses:` lines and are where an agent bumping a SHA is most
// likely to helpfully label it. A template lint proves what a site COPIED FROM;
// only a consumer-mode lint proves what a site SHIPS.
//
// This file is therefore deliberately NOT in PLATFORM_META_SPECS — the
// cms-platform#244 lesson that also keeps
// "consumer-required-context-cancellable.test.js",
// "consumer-required-check-mirrors.test.js" and
// "dependabot-theme-gem-ignored.test.js" off that list. Registering it would
// silently void it on the exact repos it exists to protect. Do not "tidy" it on.
//
// It reads only a tree a consumer really has — its own `.github` — resolved
// from SITE_ROOT, which `e2e-tests.yml` exports as `github.workspace` (the
// CONSUMER root) on the Playwright step in both the local and the preview/prod
// lane. No platform-source path appears anywhere in this file.
//
// THE INVARIANT, and why the detector parses instead of scanning lines: see
// e2e/pin-comment-rules.js. The detector is shared with the platform sibling so
// the two cannot drift apart.
//
// SKIP SEMANTICS mirror e2e/consumer-required-check-mirrors.test.js:
// `test.skip()` fires ONLY when SITE_ROOT is unset (the platform's own self-CI,
// where the platform sibling is this invariant's coverage). A genuinely
// SITE_ROOT-having run that finds no workflow files FAILS — a lint that scanned
// nothing must never read as a clean pass.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { formatOffence, pinFiles, versionCommentOffences } = require("./pin-comment-rules");

const SITE_ROOT = process.env.SITE_ROOT || null;
const SKIP_REASON =
  "SITE_ROOT is unset (platform self-CI) — a consumer's own .github tree is not present " +
  "here; e2e/action-pin-comment-lint.test.js is the platform-mode coverage of this same " +
  "invariant, over the platform tree and the thin-caller templates.";

test.describe("a consumer's own `uses:` pins carry no version comment", () => {
  test.skip(!SITE_ROOT, SKIP_REASON);

  test("the walk found the consumer's workflows", () => {
    expect(
      pinFiles(SITE_ROOT).length,
      `no pinned YAML found under ${SITE_ROOT} — a consumer that ships no workflows cannot ` +
        "be right, and a lint that scans nothing passes forever.",
    ).toBeGreaterThan(0);
  });

  test("every file parses and no pin is labelled", () => {
    const offences = [];
    for (const file of pinFiles(SITE_ROOT)) {
      const text = fs.readFileSync(file, "utf8");
      offences.push(...versionCommentOffences(text, { file: path.relative(SITE_ROOT, file) }));
    }
    expect(
      offences.map((o) => formatOffence(o)),
      "a `uses:` pin is `owner/repo@<40-hex>` and NOTHING after it. The trailing " +
        "`# vX.Y.Z (YYYY-MM-DD)` label was retired fleet-wide on 2026-08-20 because it went " +
        "stale silently and then lied. Delete the comment — do not 'correct' it. A trailing " +
        "comment that is NOT a version (e.g. `# zizmor: ignore[...]`) stays legal and is not " +
        "reported here, and a tag-pinned cms-platform ref is untouched (this lint reads only " +
        "the comment, never the ref).",
    ).toEqual([]);
  });
});
