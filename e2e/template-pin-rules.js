"use strict";
/*
 * template-pin-rules — the rule set the scaffold-template guard applies to
 * `examples/site`, in ONE place so the guard
 * (examples-site-pins-current.test.js) and the agreement spec
 * (examples-site-scaffold-agreement.test.js) cannot drift apart.
 *
 * ── WHY THERE ARE EXACTLY TWO RULES ───────────────────────────────────────
 * Two earlier rounds grew a THIRD, FOURTH, FIFTH special case (composite
 * comments, then reusable comments, then non-`uses:` positions) into a
 * hand-rolled parse-only detector, and each round shipped a fresh SPLIT: the
 * template guard green, the scaffolded site's own verify-consumer-pins.sh red.
 * An enumeration of spellings keeps losing to the next spelling. So:
 *
 *   RULE A — STALE TOKEN (general, line-aware). Literally
 *     scripts/stale-platform-refs.js, the module the consumer gate itself runs.
 *     Not a mirror of it, not a port of it — the same file, `require`d. It is
 *     the only reason a stale version token in a LEFTOVER trailing comment —
 *     on a reusable, a composite, or a `platform_ref:` line — is still caught:
 *     it lives in a COMMENT, and a YAML parser drops comments. House style
 *     carries no such comment any more, but Rule A is what makes a stray one
 *     that drifts a finding rather than invisible.
 *
 *   RULE B — STRUCTURE (parse-based). What Rule A structurally cannot see: a
 *     ref carrying NO version token at all. `@main`, `@v1`, a missing `@ref`,
 *     `platform_ref: main` — every one of them is invisible to a token scan and
 *     RED at the consumer gate (measured: a template `uses:…@main` scaffolds a
 *     site whose verify-consumer-pins.sh exits 1). This mirrors
 *     check-platform-pin-consistency.js — the consumer gate's check 4 — and per
 *     AGENTS.md ("AST always, never regex, for code-shape lints") it parses.
 *
 * Rule A ∪ Rule B is the whole contract. Neither is a spelling; adding a third
 * would be the mistake that produced this file.
 *
 * ── WHY THERE IS NOW ONE REMEDY, NOT TWO ──────────────────────────────────
 * EVERY cross-repo platform ref — reusable workflow AND composite action — is
 * pinned by TAG, so the `@ref` IS the version everywhere and one remedy covers
 * all of them: set the `@ref` to the canonical tag.
 *
 * A composite used to be the exception: SHA-pinned, with its version carried in
 * a trailing `# vX.Y.Z` comment that Rule A read and Rule B asserted the
 * PRESENCE of. That comment was retired fleet-wide (2026-08-20) because it went
 * stale silently and then actively lied — Dependabot rewrote it inconsistently,
 * leaving actions/checkout at v7.0.1 labelled `# v4.3.1` in one file and
 * `# v6.0.0` in two others in the same repo. A wrong label is worse than no
 * label. The tag ties a composite to platform.lock's `platform_ref` DIRECTLY
 * and is auditable without parsing a comment, which is the whole point.
 *
 * The rule that still holds, and the reason a SHA-pinned platform ref is a
 * finding rather than a nicety: check-platform-pin-consistency.js records a
 * platform ref's `@ref` as its version and fails a SHA-pinned one outright, so
 * a guard that accepted a SHA here would go GREEN while the consumer gate went
 * RED — the very split this file exists to close (measured: SHA-pinned reusable
 * + a CURRENT `# v0.1.84` comment -> consumer gate exit 1).
 */
const YAML = require("yaml");
const {
  PLATFORM_SLUG,
  scanStalePlatformRefs,
} = require("../scripts/stale-platform-refs.js");

// Parse with the `yaml` Document API (anchors/aliases resolved — GitHub has
// allowed them in workflows since 2025-09-18) AND keep each value's 1-based
// SOURCE LINE, so a finding can point at it.
// Mirrors check-platform-pin-consistency.js's pinNodesWithLines().
function pinNodes(text) {
  const doc = YAML.parseDocument(text);
  const uses = [];
  const platformRefs = [];
  const lineOf = (node) => text.slice(0, node.range[0]).split("\n").length;
  YAML.visit(doc, {
    Pair(_i, pair) {
      const key = pair.key && pair.key.value;
      const value = pair.value;
      if (!value || typeof value.value !== "string" || !value.range) return;
      if (key === "uses") uses.push({ uses: value.value, line: lineOf(value) });
      // A non-string `platform_ref` is an input DECLARATION, not a pin; a
      // `${{ … }}` value forwards a parameter and cannot be resolved
      // statically. Both skipped — the same rule the pin checker applies.
      else if (key === "platform_ref" && !value.value.includes("${{")) {
        platformRefs.push({ ref: value.value.trim(), line: lineOf(value) });
      }
    },
  });
  return { uses, platformRefs };
}

// Mirrors check-platform-pin-consistency.js's classifyUses(), with one
// deliberate widening: a platform ref under some OTHER subpath is still gated
// on its `@ref` here (the pin checker ignores it), because substitute()
// rewrites it on the way into a new site, so a stale value there does reach a
// scaffolded site.
function classifyUses(usesStr) {
  const at = usesStr.lastIndexOf("@");
  const target = at === -1 ? usesStr : usesStr.slice(0, at);
  const ref = at === -1 ? null : usesStr.slice(at + 1);
  const head = target.slice(0, PLATFORM_SLUG.length);
  const isSlugHead = target === PLATFORM_SLUG || target.startsWith(`${PLATFORM_SLUG}/`);
  if (!isSlugHead) {
    // A ref GitHub resolves to this platform under a different owner CASING is
    // not third-party — it is a platform ref that every case-sensitive tool in
    // the chain (the pin checker's classifyUses, the consumer gate's slug test,
    // platform-bump.yml's `\Q…\E` rewrite) silently stops version-checking. It
    // gets its own kind so the remedy can say "fix the casing" rather than
    // being swept into a version rule.
    const miscased =
      head.toLowerCase() === PLATFORM_SLUG.toLowerCase() &&
      (target.length === head.length || target[head.length] === "/");
    if (miscased) return { kind: "platform-miscased", ref, target };
    return { kind: "third-party", ref, target };
  }
  const subpath = target.slice(PLATFORM_SLUG.length + 1);
  // A composite action and a reusable workflow are BOTH tag-pinned now, so they
  // obey one version rule. `kind` still distinguishes them because callers
  // report the two differently — nothing here branches on it.
  if (/^\.github\/actions\/.+$/i.test(subpath)) return { kind: "composite", ref, subpath };
  return { kind: "platform", ref, subpath };
}

// RULE B — structure. Every platform ref must be pinned to the canonical TAG,
// which for every kind IS its version gate.
function structuralOffences(text, { canonical, file = "<text>" }) {
  const { uses, platformRefs } = pinNodes(text);
  const out = [];
  for (const { uses: value, line } of uses) {
    const cls = classifyUses(value);
    if (cls.kind === "third-party") continue;
    if (cls.kind === "platform-miscased") {
      out.push({
        rule: "structure",
        line,
        found: cls.target,
        where: `line ${line}: uses: ${value}`,
        remedy:
          `case it as '${PLATFORM_SLUG}' — a mis-cased slug is version-checked ` +
          `by nothing downstream, so it silently rots`,
        noCanonical: true,
      });
      continue;
    }
    if (cls.ref !== canonical) {
      out.push({
        rule: "structure",
        line,
        found: cls.ref === null ? "(no @ref)" : cls.ref,
        where: `line ${line}: uses: ${value}`,
        remedy: "set its @ref to",
      });
    }
  }
  for (const { ref, line } of platformRefs) {
    if (ref !== canonical) {
      out.push({
        rule: "structure",
        line,
        found: ref,
        where: `line ${line}: platform_ref: ${ref}`,
        remedy: "set it to",
      });
    }
  }
  return out;
}

// RULE A — stale token, straight from the consumer gate's own module.
function staleTokenOffences(text, { canonical, file = "<text>" }) {
  return scanStalePlatformRefs(text, { ref: canonical, file }).map((f) => ({
    rule: "stale-token",
    line: f.line,
    found: f.found,
    where: `line ${f.line}: ${(text.split("\n")[f.line - 1] || "").trim()}`,
    remedy: "every version token on a platform line must be",
  }));
}

/**
 * Rule A ∪ Rule B for one file's text. A drifted `uses:@v0.1.1` trips both on
 * the same (line, token); the structural finding wins the report because its
 * remedy is the specific one.
 */
function offences(text, opts) {
  const structural = structuralOffences(text, opts);
  const seen = new Set(structural.map((o) => `${o.line}|${o.found}`));
  const stale = staleTokenOffences(text, opts).filter(
    (o) => !seen.has(`${o.line}|${o.found}`),
  );
  return [...structural, ...stale].sort((a, b) => a.line - b.line);
}

function formatOffence(o, canonical) {
  const tail = o.noCanonical ? o.remedy : `${o.remedy} ${canonical}`;
  return `${o.where}\n    found ${o.found} — ${tail}`;
}

module.exports = {
  PLATFORM_SLUG,
  classifyUses,
  formatOffence,
  offences,
  pinNodes,
  staleTokenOffences,
  structuralOffences,
};
