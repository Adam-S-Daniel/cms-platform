// @lane: local — pure-fs lint on two mobile-breakpoint clearance/affordance
// fixes in theme/admin/admin-mobile.css (cms-platform#328.4, #329.6).
//
// #328.4 — the floating Live Preview / Reviews buttons are position:fixed
// at bottom-right and sit on top (z-index:10000) of whatever scrolls
// beneath them; on a phone the last field in a short form (e.g. a
// file-upload widget's own controls in a Media Items entry) can land
// directly under them, half-covered and hard to tap. Fix: reserve blank
// clearance at the end of the control pane.
//
// #329.6 — the collection sidebar is already touch-scrollable
// (max-height + overflow-y:auto) once it has more entries than fit in
// 35vh, but a hard-clipped 5th item gave no visual cue that scrolling
// reveals more. Fix: an inset shadow at the bottom edge, the standard
// "more content below" affordance.
//
// Parses the `@media (max-width: 768px)` block with a balanced-brace scan
// (same technique admin-css-banned-patterns.test.js uses for @keyframes —
// CSS has no library parser in this harness, so a brace-balanced substring
// extraction is the house pattern for "read one rule's body", not a flat
// regex across the whole file that could straddle unrelated rules).

const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const CSS_PATH = path.join(__dirname, "..", "theme", "admin", "admin-mobile.css");

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// Extract the body of the FIRST balanced `{...}` block found after `idx`.
function extractBlockAfter(css, idx) {
  const open = css.indexOf("{", idx);
  if (open === -1) return null;
  let depth = 1;
  let j = open + 1;
  while (j < css.length && depth > 0) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}") depth--;
    j++;
  }
  if (depth !== 0) return null;
  return css.slice(open + 1, j - 1);
}

// A rule's body is the block immediately following its selector text.
function extractRuleBody(css, selectorSubstring) {
  const idx = css.indexOf(selectorSubstring);
  if (idx === -1) return null;
  return extractBlockAfter(css, idx);
}

let mediaBlock;
test.beforeAll(() => {
  const raw = fs.readFileSync(CSS_PATH, "utf8");
  const stripped = stripCssComments(raw);
  const mqIdx = stripped.indexOf("@media (max-width: 768px)");
  expect(mqIdx, "admin-mobile.css must carry the @media (max-width: 768px) breakpoint").not.toBe(
    -1,
  );
  mediaBlock = extractBlockAfter(stripped, mqIdx);
  expect(mediaBlock, "the @media block must be a balanced {...}").not.toBeNull();
});

test.describe("admin-mobile.css — mobile clearance/affordance fixes", () => {
  test("#328.4: the form control pane reserves clearance for the floating buttons", () => {
    const body = extractRuleBody(
      mediaBlock,
      '[class*="ControlPaneContainer"]:not([class*="PreviewPaneContainer"])',
    );
    expect(
      body,
      "must carry a rule for the FORM pane specifically (excluding the preview pane), " +
        "matching the same selector shape admin/live-url-banner.js's ensureBanner() uses",
    ).not.toBeNull();
    const m = /padding-bottom\s*:\s*([\d.]+)rem\s*!important/.exec(body);
    expect(
      m,
      "must set padding-bottom in rem with !important (beats Decap's Emotion inline styles)",
    ).not.toBeNull();
    const rem = parseFloat(m[1]);
    // The two floating buttons' combined footprint on the prod shell spans
    // from bottom:3.25rem (Reviews) to roughly bottom:8.5rem (top of Live
    // Preview, ~2.5rem tall starting at bottom:6rem) — 8rem is the floor
    // below which the fix stops covering that footprint.
    expect(
      rem,
      "padding-bottom must be large enough to clear both stacked floating buttons " +
        "(Live Preview @ bottom:6rem + ~2.5rem tall, Reviews @ bottom:3.25rem)",
    ).toBeGreaterThanOrEqual(8);
  });

  test("#625.10: Reviews is hidden and the list reserves room for the stamps at phone/tablet widths", () => {
    const reviews = extractRuleBody(mediaBlock, "#reviews-link");
    expect(reviews, "the media block must carry a #reviews-link rule").not.toBeNull();
    expect(reviews).toMatch(/display\s*:\s*none\s*!important/);
    // The clearance rule is the LAST CollectionMain rule in the block.
    const body = extractBlockAfter(mediaBlock, mediaBlock.lastIndexOf('[class*="CollectionMain"]'));
    expect(body, "the collection list must reserve bottom clearance").not.toBeNull();
    const m = /padding-bottom\s*:\s*([\d.]+)rem\s*!important/.exec(body);
    expect(m, "padding-bottom in rem with !important").not.toBeNull();
    // Commit pill (bottom:1.75rem) + platform pill (bottom:0.25rem) stack ~3rem tall.
    expect(parseFloat(m[1])).toBeGreaterThanOrEqual(4);
  });

  test("#625.11: the editor box drops Decap's reserved toolbar band once the toolbar is static", () => {
    const idx = mediaBlock.lastIndexOf('[class*="EditorContainer"]');
    const body = extractBlockAfter(mediaBlock, idx);
    expect(body).toMatch(/padding-top\s*:\s*0\s*!important/);
  });

  test("#329.6: the collection sidebar carries a bottom scroll-affordance shadow", () => {
    const body = extractRuleBody(mediaBlock, 'aside[class*="SidebarContainer"]');
    expect(body, "the collection sidebar rule must still exist").not.toBeNull();
    expect(
      body,
      "must still be touch-scrollable (the mechanism #329.6 says already worked) — " +
        "this fix is additive, not a replacement",
    ).toMatch(/overflow-y\s*:\s*auto/);
    expect(
      body,
      "must carry an inset box-shadow — the standard 'more content below' affordance " +
        "for a clipped, scrollable list",
    ).toMatch(/box-shadow\s*:\s*inset\b/);
  });
});

// #640 — on desktop the in-flow #cms-publish-state bar sits between Decap's
// `padding-top: 66px` EditorContainer and its `height: 100%` Editor, so the
// container's content overflowed by the bar's height and slid the Save/Publish
// toolbar off the top. Measured in a real browser (1024x768, bar present):
// scrollHeight 814 vs clientHeight 768 before; 768 vs 768 after. This lint
// locks the rules that make that so, using the same balanced-brace scan.
test.describe("admin-mobile.css — desktop editor must not overflow (#640)", () => {
  let desktopBlock;
  test.beforeAll(() => {
    const stripped = stripCssComments(fs.readFileSync(CSS_PATH, "utf8"));
    const idx = stripped.indexOf("@media (min-width: 769px)");
    expect(idx, "admin-mobile.css must carry an @media (min-width: 769px) desktop block").not.toBe(-1);
    desktopBlock = extractBlockAfter(stripped, idx);
    expect(desktopBlock, "the desktop @media block must be a balanced {...}").not.toBeNull();
  });

  test("the editor box is a flex column so the bar and the pane share its height", () => {
    const body = extractRuleBody(desktopBlock, '[class*="EditorContainer"] {');
    expect(body, "the desktop block must carry an EditorContainer rule").not.toBeNull();
    expect(body).toMatch(/display\s*:\s*flex/);
    expect(body).toMatch(/flex-direction\s*:\s*column/);
  });

  test("the pane shrinks (min-height 0, full width) and the bar keeps its own height", () => {
    const pane = extractRuleBody(desktopBlock, '> :not(#cms-publish-state)');
    expect(pane, "the non-bar children need a rule").not.toBeNull();
    expect(pane).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(pane).toMatch(/min-height\s*:\s*0/);
    // Decap's Editor is `margin: 0 auto`, which collapses to width 0 in a column.
    expect(pane).toMatch(/width\s*:\s*100%/);
    const bar = extractRuleBody(desktopBlock, "> #cms-publish-state");
    expect(bar, "the bar needs a rule").not.toBeNull();
    expect(bar).toMatch(/flex\s*:\s*0\s+0\s+auto/);
  });
});
