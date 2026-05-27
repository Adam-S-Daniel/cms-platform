// @lane: local — pure-fs CSS lint; no browser, no network
// Lint: ban CSS patterns that mis-composite the Decap CMS form on iOS WebKit.
//
// Background — iOS Safari (and iOS Chrome, which is just Safari WebKit under
// the hood) treats certain compositing-layer triggers as opaque overlays
// and ends up hiding the entry-edit form fields underneath the toolbar.
// The bug shows as an empty Decap form on real iPhones. Confirmed by repeat
// regression in PRs #48 / #81 — every time someone re-introduces the
// "ambient glow" pseudo-element with a scaling keyframe + blurred toolbar,
// the form goes blank. Background-only animations (e.g. plain colour fades)
// are fine; the three patterns below are the load-bearing ones.
//
// Banned patterns:
//   1. `body::before { ... position: fixed }` — full-viewport pseudo-element
//      that creates a stacking context above the editor.
//   2. `@keyframes ... transform: scale(...)` — scale animations promote
//      the layer to the GPU and trip the same WebKit compositing bug.
//   3. `backdrop-filter: blur(...)` — blurred toolbar over the form is
//      what actually occludes the inputs visually.
//
// Scope: every `admin/*.css` file plus the inline `<style>` blocks in
// `admin/index*.html`. We strip CSS comments before scanning so the
// regression notes in the source files (which deliberately reference these
// patterns to explain why they were removed) don't trip the lint.

const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "admin");

function stripCssComments(css) {
  // Remove /* ... */ blocks so commented-out examples don't false-positive.
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function extractInlineStyles(html) {
  // HTML <style> blocks may contain CSS comments; strip them too.
  const blocks = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    blocks.push(m[1]);
  }
  return blocks.join("\n");
}

function collectSources() {
  const sources = [];

  for (const name of fs.readdirSync(ADMIN_DIR)) {
    const full = path.join(ADMIN_DIR, name);
    if (!fs.statSync(full).isFile()) continue;
    if (name.endsWith(".css")) {
      sources.push({
        label: `admin/${name}`,
        css: fs.readFileSync(full, "utf8"),
      });
    } else if (/^index.*\.html$/.test(name)) {
      const html = fs.readFileSync(full, "utf8");
      const inline = extractInlineStyles(html);
      if (inline.trim()) {
        sources.push({ label: `admin/${name} <style>`, css: inline });
      }
    }
  }

  return sources;
}

const SOURCES = collectSources();

test("admin CSS sources are present (sanity)", () => {
  expect(SOURCES.length).toBeGreaterThan(0);
});

test("no body::before rule with position: fixed", () => {
  const offenders = [];
  for (const { label, css } of SOURCES) {
    const stripped = stripCssComments(css);
    // Match a body::before block and check whether it contains position:fixed.
    const ruleRe = /body\s*::\s*before\s*\{([^}]*)\}/gi;
    let m;
    while ((m = ruleRe.exec(stripped)) !== null) {
      if (/position\s*:\s*fixed\b/i.test(m[1])) {
        offenders.push(`${label}: body::before { ... position: fixed }`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("no @keyframes rule contains transform: scale(...)", () => {
  const offenders = [];
  for (const { label, css } of SOURCES) {
    const stripped = stripCssComments(css);
    // Walk @keyframes blocks balanced — they have nested {} so a flat regex
    // is unsafe. Slice the substring that contains the @keyframes body.
    let i = 0;
    while (i < stripped.length) {
      const idx = stripped.indexOf("@keyframes", i);
      if (idx === -1) break;
      // Find the first { after the name.
      const open = stripped.indexOf("{", idx);
      if (open === -1) break;
      // Walk to the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < stripped.length && depth > 0) {
        if (stripped[j] === "{") depth++;
        else if (stripped[j] === "}") depth--;
        j++;
      }
      const body = stripped.slice(open + 1, j - 1);
      if (/transform\s*:\s*[^;}]*scale\s*\(/i.test(body)) {
        const name = stripped.slice(idx, open).replace(/\s+/g, " ").trim();
        offenders.push(`${label}: ${name} contains transform: scale(...)`);
      }
      i = j;
    }
  }
  expect(offenders).toEqual([]);
});

test("no rule uses backdrop-filter: blur(...)", () => {
  const offenders = [];
  for (const { label, css } of SOURCES) {
    const stripped = stripCssComments(css);
    if (/backdrop-filter\s*:\s*[^;}]*blur\s*\(/i.test(stripped)) {
      offenders.push(`${label}: backdrop-filter: blur(...)`);
    }
  }
  expect(offenders).toEqual([]);
});
