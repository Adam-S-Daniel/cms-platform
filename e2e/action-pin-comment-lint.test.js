// @lane: local — pure-fs, PLATFORM lint (parses with the `yaml` library, never
// a regex over source) asserting that no `uses:` pin in this repo carries a
// trailing VERSION comment.
//
// THE INVARIANT
// -------------
// A pin is `owner/repo@<40-hex>` and NOTHING after it. The trailing
// `# vX.Y.Z (YYYY-MM-DD)` label house style carried until 2026-08-20 was
// retired fleet-wide because it went stale silently and then actively lied —
// Dependabot rewrote it inconsistently, leaving actions/checkout at v7.0.1
// labelled `# v4.3.1` in one file and `# v6.0.0` in two others in the same
// repo. A wrong label is worse than no label.
//
// Eleven PRs stripped the label and deleted every generator that maintained it,
// and nothing then ASSERTED its absence. That is the gap this file closes: a
// convention with no verifier comes back the first time an agent helpfully
// labels a SHA it just bumped, which is how the labels drifted out of true to
// begin with. The rule now has a lint, like the required-context rule
// (required-context-cancellable.test.js) and the template pin rules
// (template-pin-rules.js) before it.
//
// WHAT IS COVERED
// ---------------
// Three trees, all platform-owned:
//   .github/workflows/                       — this repo's workflows + reusables
//   .github/actions/*/action.yml             — the composite actions
//   examples/site/.github/workflows/         — the thin-caller TEMPLATES a site
//                                              copies from
//
// WHAT IS NOT, AND WHY THIS SPEC IS REGISTERED ANYWAY
// ---------------------------------------------------
// Registering a name in playwright.config.js's PLATFORM_META_SPECS testIgnores
// it on every CONSUMER lane, so this half of the surface is the platform tree
// and the templates — never the copies a consumer actually ships, which is
// where two thirds of the fleet's `uses:` lines live. Registration is still
// correct: this spec resolves its root from `__dirname/..` and asserts against
// the platform's OWN workflow definitions, which a consumer checkout does not
// have in that position. The other half is
// "consumer-action-pin-comment-lint.test.js", deliberately absent from
// PLATFORM_META_SPECS for exactly the cms-platform#244 reason that keeps
// "consumer-required-context-cancellable.test.js" off it too.
//
// THE DETECTOR LIVES IN e2e/pin-comment-rules.js — one module, so this lint and
// its consumer sibling cannot drift apart. Read that file's header for why the
// comment is reachable through `YAML.parseDocument()` (it is: verified against
// `yaml` 2.9.0 for plain, quoted, last-line-no-newline, composite-action and
// flow-mapping shapes) and why parsing rather than scanning lines is what makes
// the guard CORRECT rather than merely house-style-compliant.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const {
  formatOffence,
  isVersionComment,
  pinComments,
  pinFiles,
  versionCommentOffences,
} = require("./pin-comment-rules");

const REPO_ROOT = path.resolve(__dirname, "..");
// Named explicitly rather than left implicit inside pinFiles(): this spec reads
// the PLATFORM'S OWN reusable workflow definitions, and naming the directory
// here is what lets e2e/platform-meta-spec-registry.test.js's static detector
// see that (it reads a spec's source, and cannot follow a `require`). Without
// it the registry gate would have to take this file's registration on trust.
const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

const FILES = pinFiles(REPO_ROOT, { examplesSite: true });
const rel = (f) => path.relative(REPO_ROOT, f);

test.describe("no `uses:` pin carries a trailing version comment", () => {
  // A lint that scans nothing passes forever. Assert the walk reached all
  // THREE trees before believing any green result from it.
  test("the walk reached all three pin-bearing trees", () => {
    const buckets = {
      "workflows": FILES.filter((f) => path.dirname(f) === WORKFLOWS_DIR),
      "composite actions": FILES.filter((f) => /action\.ya?ml$/.test(f)),
      "thin-caller templates": FILES.filter((f) => rel(f).startsWith(`examples${path.sep}site`)),
    };
    const empty = Object.keys(buckets).filter((k) => buckets[k].length === 0);
    expect(
      empty,
      "these pin-bearing trees produced no files — the lint would pass vacuously: " +
        empty.join(", "),
    ).toEqual([]);
  });

  test("every file parses and no pin is labelled", () => {
    const offences = [];
    for (const file of FILES) {
      const text = fs.readFileSync(file, "utf8");
      // No try/catch: a YAML file in these trees that will not parse is a real
      // bug (actionlint's job too), never a file to wave through as clean.
      offences.push(...versionCommentOffences(text, { file: rel(file) }));
    }
    expect(
      offences.map((o) => formatOffence(o)),
      "a `uses:` pin is `owner/repo@<40-hex>` and NOTHING after it. The trailing " +
        "`# vX.Y.Z (YYYY-MM-DD)` label was retired fleet-wide on 2026-08-20 because it " +
        "went stale silently and then lied (actions/checkout at v7.0.1 was labelled " +
        "`# v4.3.1` in one file and `# v6.0.0` in two others in the same repo). Delete " +
        "the comment — do not 'correct' it. A trailing comment that is NOT a version " +
        "(e.g. `# zizmor: ignore[...]`) stays legal and is not reported here.",
    ).toEqual([]);
  });

  // ── NEGATIVE CONTROLS ───────────────────────────────────────────────────
  // A lint that cannot fail is worse than no lint. These drive the detector
  // over synthesised fixtures in both directions, so a regression to a no-op
  // (or to over-reach) turns THIS red instead of silently un-protecting the
  // tree above.
  test.describe("the detector discriminates", () => {
    const step = (line) => `jobs:\n  j:\n    steps:\n      - ${line}\n`;

    test("a commented pin IS flagged, an uncommented one is NOT", () => {
      const dirty = step("uses: actions/checkout@" + "0".repeat(40) + " # v4.1.1 (2023-10-17)");
      const clean = step("uses: actions/checkout@" + "0".repeat(40));

      const found = versionCommentOffences(dirty, { file: "dirty.yml" });
      expect(found.length, "the retired label shape MUST be detected").toBe(1);
      expect(found[0].comment).toBe("v4.1.1 (2023-10-17)");
      expect(found[0].line, "the finding must point at the pin's own line").toBe(4);

      expect(
        versionCommentOffences(clean, { file: "clean.yml" }),
        "a bare SHA pin — the house style this lint exists to keep — must never be flagged",
      ).toEqual([]);
    });

    test("every abbreviation of the retired label is still a version label", () => {
      for (const c of [" v4.1.1 (2023-10-17)", " v4.1.1", " v4", " 4.1.1", " (2023-10-17)"]) {
        expect(isVersionComment(c), `"${c}" is a version label`).toBe(true);
      }
    });

    test("a NON-version trailing comment is legal and untouched", () => {
      for (const c of [
        "uses: actions/checkout@" + "0".repeat(40) + " # zizmor: ignore[template-injection]",
        "uses: actions/checkout@" + "0".repeat(40) + " # see issue #1815",
      ]) {
        const text = step(c);
        expect(
          pinComments(text).length,
          "the comment must still be SEEN (else the filter below proves nothing)",
        ).toBe(1);
        expect(
          versionCommentOffences(text, { file: "directive.yml" }),
          "a directive or a prose note carries nothing that can rot — it is not a label",
        ).toEqual([]);
      }
    });

    // THE REASON THIS PARSES INSTEAD OF SCANNING LINES. Both of these lines
    // carry a version token that a line regex matches — and both are LEGAL,
    // because the token is in the VALUE, not in a comment. A lexical guard
    // flags them; the parser separates value from comment and says nothing.
    test("a version token in the VALUE is not a comment (the line-scan trap)", () => {
      for (const line of [
        "uses: Adam-S-Daniel/cms-platform/.github/workflows/e2e-tests.yml@v0.1.88",
        "uses: docker://alpine:3.20",
        "uses: ./.github/actions/cms-recursion-gate",
      ]) {
        const text = step(line);
        expect(
          /\bv?\d+\.\d+/.test(line),
          "fixture sanity: this line must contain a token a line scan would match",
        ).toBe(line.includes("alpine") || line.includes("v0.1.88"));
        expect(
          versionCommentOffences(text, { file: "legal.yml" }),
          `"${line}" is a legal pin — a tag-pinned own-account ref, a docker:// ref and a ` +
            "./local path are all untouched here, because this lint reads ONLY the comment",
        ).toEqual([]);
      }
    });

    // The flow-mapping branch of pinComments() would otherwise be dead code no
    // test ever entered — nothing in the fleet writes a step in flow style, and
    // an unexercised branch is one silent refactor away from being wrong.
    test("a flow-style step's trailing comment is found too", () => {
      const text =
        `jobs:\n  j:\n    steps:\n      - { uses: actions/checkout@abc } # v4.1.1\n`;
      const found = versionCommentOffences(text, { file: "flow.yml" });
      expect(
        found.length,
        "a flow-mapping step hangs its comment off the Map, not the scalar",
      ).toBe(1);
      expect(found[0].uses).toBe("actions/checkout@abc");
    });

    // A block mapping's own `.comment` is the comment AFTER the whole mapping
    // ends — it belongs to no pin. Claiming it would flag ordinary workflow
    // prose; this locks the flow-only restriction that prevents that.
    test("a comment on its own line below a pin belongs to no pin", () => {
      const text =
        `jobs:\n  j:\n    steps:\n      - uses: actions/checkout@abc\n` +
        `        # v4.1.1 — an explanatory note, not a label on the pin\n        with: {}\n`;
      expect(
        versionCommentOffences(text, { file: "below.yml" }),
        "only the SAME-LINE trailing comment is a pin label; a comment on the next line is " +
          "an ordinary workflow comment and must not be claimed",
      ).toEqual([]);
    });
  });
});
