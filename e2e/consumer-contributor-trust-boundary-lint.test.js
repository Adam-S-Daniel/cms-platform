// @lane: local — pure-fs, CONSUMER-ONLY lint (parses with the `yaml` library and
// acorn, never a regex over source) holding the contributor trust boundary for
// previews (#536) on the workflows a consumer actually SHIPS.
//
// WHY THIS EXISTS — THE HALF ITS PLATFORM SIBLING CANNOT COVER
// ------------------------------------------------------------
// e2e/contributor-trust-boundary-lint.test.js checks the platform tree and the
// canonical thin callers under examples/site/. A consumer's real callers can
// differ where it matters most: pin-consistency's caller parity deliberately
// EXCLUDES `on:` (sites tune their triggers), so a consumer could move its
// deploy-preview caller to `pull_request_target` and every other check would
// stay green while fork code deployed to a trusted sign-in origin with the
// AWS role. Only a consumer-mode lint proves what a site ships.
//
// This file is therefore deliberately NOT in PLATFORM_META_SPECS, the
// cms-platform#244 lesson that keeps "consumer-action-pin-comment-lint.test.js"
// and "consumer-required-context-cancellable.test.js" off that list too.
// Registering it would testIgnore it on the exact repos it exists to protect.
//
// It reads only trees a consumer has: `<SITE_ROOT>/.github/workflows` (its own
// callers) and `<SITE_ROOT>/.cms-platform/.github/workflows` (the full platform
// checkout e2e-tests.yml makes at the consumer's pinned ref), so each reusable
// is judged under the trigger THIS consumer calls it with. Every join names
// SITE_ROOT directly, for the reason consumer-required-context-cancellable
// gives (the registry's #244 carve-out reads the join's own arguments).
//
// SKIP SEMANTICS: `test.skip()` fires ONLY when SITE_ROOT is unset (platform
// self-CI, where the sibling is the coverage). A SITE_ROOT-having run without
// workflows or without the platform checkout FAILS: a lint that scanned nothing
// must never read as a clean pass.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { formatOffence, lintWorkflows } = require("./contributor-trust-boundary-rules");

const SITE_ROOT = process.env.SITE_ROOT || null;
const CALLER_DIR = SITE_ROOT ? path.join(SITE_ROOT, ".github", "workflows") : null;
const REUSABLE_DIR = SITE_ROOT ? path.join(SITE_ROOT, ".cms-platform", ".github", "workflows") : null;

function readTree(dir, origin) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((name) => ({ file: `${origin}:${name}`, name, origin, text: fs.readFileSync(path.join(dir, name), "utf8") }));
}

test.describe("a consumer's own workflows hold the contributor trust boundary", () => {
  test.skip(
    !SITE_ROOT,
    "SITE_ROOT is unset (platform self-CI): e2e/contributor-trust-boundary-lint.test.js is the " +
      "platform-mode coverage of this invariant, over the platform tree and the thin-caller templates.",
  );

  test("the consumer's callers cross no trust boundary", () => {
    expect(fs.existsSync(CALLER_DIR), `${CALLER_DIR} is missing`).toBe(true);
    expect(fs.existsSync(REUSABLE_DIR), `${REUSABLE_DIR} is missing: the e2e job's platform checkout`).toBe(true);
    const callers = readTree(CALLER_DIR, "consumer");
    expect(callers.length, "no consumer workflows read").toBeGreaterThan(0);
    const { offences } = lintWorkflows([...callers, ...readTree(REUSABLE_DIR, "platform")], {
      platformRepo: "Adam-S-Daniel/cms-platform",
    });
    expect(
      offences.map(formatOffence),
      "a workflow this site ships crossed the contributor trust boundary: fork code must never " +
        "run with secrets or a write token, because a preview receives the editor's token. See the " +
        "platform's e2e/contributor-trust-boundary-rules.js and docs/ADMIN-AUTH-SECURITY.md.",
    ).toEqual([]);
  });
});
