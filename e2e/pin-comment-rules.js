"use strict";
/*
 * pin-comment-rules — the detector behind the "a pin carries no version
 * comment" guard, in ONE place so the platform lint
 * (action-pin-comment-lint.test.js) and its CONSUMER-mode sibling
 * (consumer-action-pin-comment-lint.test.js) cannot drift apart.
 *
 * ── THE INVARIANT ─────────────────────────────────────────────────────────
 * A `uses:` pin is `owner/repo@<40-hex>` and NOTHING after it. The trailing
 * `# vX.Y.Z (YYYY-MM-DD)` label that house style carried until 2026-08-20 was
 * retired fleet-wide, because it went stale silently and then actively lied:
 * Dependabot rewrote it inconsistently, leaving actions/checkout at v7.0.1
 * labelled `# v4.3.1` in one file and `# v6.0.0` in two others in the SAME
 * repo. A wrong label is worse than no label — it is a fact a reader trusts
 * and a scanner cannot check.
 *
 * ── WHY A GUARD, AND WHY NOW ──────────────────────────────────────────────
 * Eleven PRs stripped the comment fleet-wide and deleted every generator that
 * maintained it, but nothing ASSERTS its absence. Every other load-bearing
 * invariant in this account is lint-locked by a parser-based test — the
 * required-context rule (required-context-cancellable.test.js), the workflow
 * path rule, the template pin rules (template-pin-rules.js). This one was
 * enforced by convention alone, and a convention with no verifier comes back
 * the first time an agent "helpfully" labels a SHA it just bumped. That is
 * exactly how the labels drifted out of true in the first place.
 *
 * ── WHY THIS PARSES INSTEAD OF SCANNING LINES ─────────────────────────────
 * The repo's standing rule is AST/parser-based lints, never a regex over
 * source (AGENTS.md, "AST always, never regex, for code-shape lints"). YAML
 * comments are NOT in the YAML data model, so `YAML.parse()` drops them — but
 * `YAML.parseDocument()` KEEPS them, hanging a same-line trailing comment off
 * the node it follows as `node.comment`. Verified against `yaml` 2.9.0 for
 * every shape that occurs here: plain scalar, quoted scalar, the last line of
 * a file with no trailing newline, a step inside a composite `action.yml`, and
 * a flow-mapping step (where the comment lands on the flow Map instead — see
 * `pinComments()`). So the comment IS reachable through the parser and there
 * is no reason to fall back to a lexical read.
 *
 * That is not pedantry — parsing is what makes the guard CORRECT. A line scan
 * for a version token cannot tell a comment from the value it follows, and the
 * two LEGAL shapes that carry a version token IN THE VALUE are both common
 * here:
 *
 *     uses: Adam-S-Daniel/cms-platform/.github/workflows/e2e-tests.yml@v0.1.88
 *     uses: docker://alpine:3.20
 *
 * A line regex flags both. The parser sees `.comment === undefined` on each and
 * says nothing. Both are locked as negative controls in the lint's own tests.
 *
 * ── WHAT COUNTS AS A VERSION COMMENT ──────────────────────────────────────
 * A trailing comment carrying a version token or a bare ISO date — i.e. the
 * retired label and every abbreviation of it (`# v4.1.1 (2023-10-17)`, `# v4`,
 * `# 4.1.1`, `# (2023-10-17)`). A trailing comment that carries neither is
 * legal and untouched: `# zizmor: ignore[template-injection]` is a directive,
 * not a label, and nothing about it rots.
 *
 * ── WHAT THIS DELIBERATELY DOES NOT DO ────────────────────────────────────
 * It does not police the REF. Whether a pin should be a SHA or a tag is
 * check-platform-pin-consistency.js's question (and template-pin-rules.js's
 * for the scaffold template); this file only ever reads the comment, so a
 * tag-pinned own-account ref, a `./local/path` and a `docker://` ref are all
 * inherently untouched — there is no carve-out to get wrong.
 *
 * It also reads only the SAME-LINE trailing comment, which is the label
 * position and the only one the retired convention ever used. A comment on its
 * own line below a `uses:` is `commentBefore` of a SIBLING key (`with:`,
 * `name:`) — an ordinary workflow-comment position that belongs to no pin, and
 * claiming it would flag every explanatory comment in every workflow.
 */
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");

// A version TOKEN. Three alternatives, each anchored on word boundaries so a
// digit run inside a longer word never matches:
//   v?MAJOR.MINOR[.PATCH][-prerelease]  — `v4.1.1`, `4.1.1`, `v1.2.3-beta.1`
//   vMAJOR                              — `v4`, the movable-tag spelling
//   YYYY-MM-DD                          — the date half of the retired label,
//                                         which also stands alone once someone
//                                         "tidies" the version out of it
const VERSION_TOKEN =
  /\bv?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?\b|\bv\d+\b|\b\d{4}-\d{2}-\d{2}\b/;

/** Is this trailing-comment text a VERSION LABEL (vs. a directive/prose)? */
function isVersionComment(comment) {
  return typeof comment === "string" && VERSION_TOKEN.test(comment);
}

/** 1-based source line containing byte offset `off`. */
function lineOf(text, off) {
  return text.slice(0, off).split("\n").length;
}

/**
 * Every `uses:` pin in `text` that carries a SAME-LINE trailing comment, as
 * `{ uses, comment, line }`. Driven by the `yaml` Document API, so anchors and
 * aliases are resolved and the value is cleanly separated from the comment.
 *
 * TWO node positions, because YAML puts the trailing comment in two different
 * places depending on the step's style, and both are a `uses:` line:
 *
 *   BLOCK (every step in the fleet today)
 *       - uses: actions/checkout@abc  # v4.1.1
 *     …the comment hangs off the `uses:` VALUE scalar.
 *
 *   FLOW (nothing uses it today; a re-adder easily could)
 *       - { uses: actions/checkout@abc }  # v4.1.1
 *     …the value scalar has none — the comment hangs off the flow Map. Only
 *     `flow === true` maps are read, so a BLOCK map's `.comment` (which is the
 *     comment AFTER the whole mapping ends, owned by no pin) is never claimed.
 *
 * A malformed document throws; callers surface it as the parse failure it is
 * rather than reporting a clean file.
 */
function pinComments(text) {
  const doc = YAML.parseDocument(text);
  const out = [];
  YAML.visit(doc, {
    Pair(_i, pair) {
      if (!pair.key || String(pair.key.value) !== "uses") return;
      const value = pair.value;
      if (!value || typeof value.value !== "string" || !value.range) return;
      if (!value.comment) return;
      out.push({ uses: value.value, comment: value.comment, line: lineOf(text, value.range[0]) });
    },
    Map(_i, node) {
      if (node.flow !== true || !node.comment || !node.range) return;
      const usesPair = (node.items || []).find((p) => p.key && String(p.key.value) === "uses");
      if (!usesPair || !usesPair.value || typeof usesPair.value.value !== "string") return;
      out.push({
        uses: usesPair.value.value,
        comment: node.comment,
        line: lineOf(text, node.range[0]),
      });
    },
  });
  return out.sort((a, b) => a.line - b.line);
}

/**
 * The offences in one file's text: every `uses:` pin whose trailing comment is
 * a VERSION LABEL. `file` is carried through for the report only.
 */
function versionCommentOffences(text, { file = "<text>" } = {}) {
  return pinComments(text)
    .filter((hit) => isVersionComment(hit.comment))
    .map((hit) => ({ file, line: hit.line, uses: hit.uses, comment: hit.comment.trim() }));
}

function formatOffence(o) {
  return (
    `${o.file}:${o.line}\n` +
    `    uses: ${o.uses}   # ${o.comment}\n` +
    `    → delete the trailing comment; the \`@ref\` itself is the pin`
  );
}

/**
 * Every YAML file a pin can live in under `root`: the workflows directory, the
 * composite actions' `action.yml`, and — when `examplesSite` is set — the
 * thin-caller TEMPLATES a site copies from. Missing directories yield nothing
 * (a consumer ships no `.github/actions` of its own); it is the CALLER's job to
 * assert it found something, so an empty walk can never read as a clean pass.
 */
function pinFiles(root, { examplesSite = false } = {}) {
  const isYaml = (f) => /\.ya?ml$/.test(f);
  const listDir = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter(isYaml).map((f) => path.join(dir, f));
  };

  const out = [...listDir(path.join(root, ".github", "workflows"))];

  const actionsDir = path.join(root, ".github", "actions");
  let actionDirs = [];
  try {
    actionDirs = fs
      .readdirSync(actionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(actionsDir, d.name));
  } catch {
    actionDirs = [];
  }
  for (const dir of actionDirs) out.push(...listDir(dir).filter((f) => /action\.ya?ml$/.test(f)));

  if (examplesSite) {
    out.push(...listDir(path.join(root, "examples", "site", ".github", "workflows")));
  }

  return out.sort();
}

module.exports = {
  VERSION_TOKEN,
  formatOffence,
  isVersionComment,
  pinComments,
  pinFiles,
  versionCommentOffences,
};
