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
 *     the only reason a trailing `# vX.Y.Z` comment on a reusable, on a
 *     composite, or on a `platform_ref:` line is caught: those live in a
 *     COMMENT, and a YAML parser drops comments.
 *
 *   RULE B — STRUCTURE (parse-based). What Rule A structurally cannot see: a
 *     ref carrying NO version token at all. `@main`, `@v1`, a missing `@ref`,
 *     `platform_ref: main`, a composite with no `# vX.Y.Z` comment — every one
 *     of them is invisible to a token scan and RED at the consumer gate
 *     (measured: a template `uses:…@main` scaffolds a site whose
 *     verify-consumer-pins.sh exits 1). This mirrors
 *     check-platform-pin-consistency.js — the consumer gate's check 4 — and per
 *     AGENTS.md ("AST always, never regex, for code-shape lints") it parses.
 *
 * Rule A ∪ Rule B is the whole contract. Neither is a spelling; adding a third
 * would be the mistake that produced this file.
 *
 * ── WHAT THE TWO REMEDIES SAY, AND WHY THEY DIFFER ────────────────────────
 * A platform REUSABLE is pinned by TAG and a platform COMPOSITE by SHA, so the
 * version GATE is in a different place for each and the advice has to be too:
 *
 *   reusable / any other subpath → the `@ref` IS the version. Its remedy names
 *     the ref, including when the ref is a SHA. That is NOT the un-pin advice
 *     it resembles: check-platform-pin-consistency.js records a reusable's
 *     `@ref` as its version and fails a SHA-pinned one outright, so a guard
 *     that told a SHA-pinned reusable to "fix its comment" instead would go
 *     GREEN while the consumer gate went RED — re-opening the very split this
 *     file closes (measured: SHA-pinned reusable + a CURRENT `# v0.1.84`
 *     comment → consumer gate exit 1).
 *   composite → SHA-pinned by house policy; its `@ref` is never compared and
 *     never named in the advice (replacing a composite's SHA with a tag would
 *     un-pin it). The gate is its trailing comment, read by Rule A; Rule B only
 *     asserts a comment EXISTS.
 */
const YAML = require("yaml");
const {
  PLATFORM_SLUG,
  scanStalePlatformRefs,
} = require("../scripts/stale-platform-refs.js");

// Parse with the `yaml` Document API (anchors/aliases resolved — GitHub has
// allowed them in workflows since 2025-09-18) AND keep each value's 1-based
// SOURCE LINE, which is what the composite-comment presence check needs.
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
  return { uses, platformRefs, lines: text.split("\n") };
}

// The trailing `# …` comment on a 1-based source line. Rule B needs only its
// PRESENCE (a composite with no version comment has no gate at all); the
// comment's VALUE is Rule A's business.
function trailingComment(lines, line1) {
  const lineStr = lines[line1 - 1] || "";
  const hash = lineStr.indexOf("#");
  return hash === -1 ? "" : lineStr.slice(hash + 1).trim();
}

function versionFromComment(comment) {
  const m = comment.match(/\bv\d+(?:\.\d+){0,3}\b/);
  return m ? m[0] : null;
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
  if (/^\.github\/actions\/.+$/i.test(subpath)) return { kind: "composite", ref, subpath };
  return { kind: "platform", ref, subpath };
}

// RULE B — structure. Every platform ref must carry a version GATE, in the
// place its kind puts it.
function structuralOffences(text, { canonical, file = "<text>" }) {
  const { uses, platformRefs, lines } = pinNodes(text);
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
    if (cls.kind === "composite") {
      // SHA-pinned by policy: never compare the ref, never name it. Only
      // assert the gate EXISTS — Rule A checks its value.
      if (!versionFromComment(trailingComment(lines, line))) {
        out.push({
          rule: "structure",
          line,
          found: "(no # vX.Y.Z comment)",
          where: `line ${line}: uses: ${value}`,
          remedy: "give it a trailing `# vX.Y.Z (date)` comment naming",
        });
      }
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
  trailingComment,
  versionFromComment,
};
