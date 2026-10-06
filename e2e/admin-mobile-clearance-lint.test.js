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

// #731 — on a phone the editor toolbar (Save / Publish / Delete) scrolled
// away with the page, took ~185px of the first screen, and the date field's
// "Clear" button ran off the right edge. Measured against the real Decap
// 3.15.1 bundle at 390x844 (toolbar bottom 185 -> 93, Clear right edge
// 435 -> 170 against a 390px viewport; scrolled to the end, the toolbar sat at
// top 0 instead of -3380). This lint locks the rules that make that so. It
// parses the stylesheet with postcss (a real AST) instead of the brace scan
// above, because it reads nested at-rules (@supports inside @media) and
// declaration priority.
const postcss = require("postcss");

test.describe("admin-mobile.css — phone toolbar and date field (#731)", () => {
  let root;
  let mq768;
  let mq600;
  let mq1100;
  let mqTablet;
  let supports;

  const findAtRule = (parent, name, params) => {
    let found = null;
    parent.each((n) => {
      if (!found && n.type === "atrule" && n.name === name && n.params === params) found = n;
    });
    return found;
  };
  // EVERY rule in the container (nested at-rules included, document order)
  // whose selector list names `selector`. Checking only the first match would
  // let a later override of the same selector pass.
  const rulesFor = (container, selector) => {
    const out = [];
    container.walkRules((r) => {
      if (r.selectors.includes(selector)) out.push(r);
    });
    return out;
  };
  // The declaration that wins among all matching rules: the last one in
  // document order (every rule here has the same specificity, and all carry
  // !important where it matters). A later override therefore fails the test.
  const effective = (container, selector, prop) => {
    let win = null;
    for (const r of rulesFor(container, selector)) {
      r.walkDecls(prop, (d) => {
        if (d.parent === r) win = { value: d.value.trim(), important: !!d.important };
      });
    }
    return win;
  };

  const TOOLBAR = '[class*="EditorContainer"] > [class*="ToolbarContainer"]';

  test.beforeAll(() => {
    root = postcss.parse(fs.readFileSync(CSS_PATH, "utf8"));
    mq768 = findAtRule(root, "media", "(max-width: 768px)");
    mq600 = findAtRule(root, "media", "(max-width: 600px)");
    mq1100 = findAtRule(root, "media", "(max-width: 1100px)");
    mqTablet = findAtRule(root, "media", "(min-width: 601px) and (max-width: 1100px)");
    expect(mq768, "the @media (max-width: 768px) block").not.toBeNull();
    expect(mq600, "an @media (max-width: 600px) phone block").not.toBeNull();
    expect(mq1100, "an @media (max-width: 1100px) tablet-and-phone block").not.toBeNull();
    expect(mqTablet, "an @media (min-width: 601px) and (max-width: 1100px) block").not.toBeNull();
    supports = findAtRule(mq600, "supports", "(overflow: clip)");
    expect(
      supports,
      "the sticky rules must sit inside @supports (overflow: clip): without it the " +
        "body stays a scroll container and sticky pins to a body that never scrolls",
    ).not.toBeNull();
  });

  test("the editor toolbar is sticky at the top, above Decap's controls and below the modals", () => {
    expect(
      rulesFor(supports, TOOLBAR).length,
      "the rule must match the toolbar as a DIRECT child of the editor box, so Decap's " +
        "other ...Toolbar... components stay untouched",
    ).toBeGreaterThan(0);
    // Rule 3's `position: static !important` is earlier and equally specific.
    expect(effective(mq600, TOOLBAR, "position")).toEqual({ value: "sticky", important: true });
    expect(effective(mq600, TOOLBAR, "top").value).toBe("0");
    const z = Number(effective(mq600, TOOLBAR, "z-index")?.value);
    // Decap's highest in-editor z-index is 600; the floating links use 10000.
    expect(z, "z-index between Decap's controls and the floating links").toBeGreaterThan(600);
    expect(z).toBeLessThan(10000);
    expect(effective(mq600, TOOLBAR, "background")?.value, "opaque, or the form shows through").toBe(
      "#fff",
    );
  });

  test("nothing between the toolbar and the viewport is a scroll container", () => {
    // `html, body { overflow-x: hidden }` (rule 1) turns body's overflow-y into
    // auto, and Decap's editor box is `overflow: hidden`; either breaks sticky.
    expect(effective(mq600, "body", "overflow-x")).toEqual({ value: "clip", important: true });
    expect(effective(mq600, '[class*="EditorContainer"]', "overflow")).toEqual({
      value: "visible",
      important: true,
    });
  });

  test("Decap's own app header keeps scrolling away on the list screens", () => {
    // With body no longer a scroll container, Decap's `position: sticky`
    // header would pin to the top of every collection list (100px at 390px,
    // 127px at 320px). On main it scrolled away; this keeps it that way.
    expect(effective(mq600, 'header[class*="AppHeader"]', "position")).toEqual({
      value: "static",
      important: true,
    });
    expect(
      rulesFor(supports, 'header[class*="AppHeader"]').length,
      "the header rule must sit in the same @supports block as the body clip that causes the need",
    ).toBeGreaterThan(0);
  });

  test("the phone block comes after the 768px block so its sticky rule wins rule 5", () => {
    expect(root.index(mq600)).toBeGreaterThan(root.index(mq768));
  });

  test("the toolbar is compact: back link and avatar share a row, the hostname is hidden", () => {
    const sel = (part) => `${TOOLBAR} [class*="${part}"]`;
    expect(effective(mq600, sel("AppHeaderSiteLink"), "display")).toEqual({
      value: "none",
      important: true,
    });
    // `flex: 1 1 100%` (rule 5) is what forces one section per row.
    expect(effective(mq600, sel("ToolbarSectionBackLink"), "flex")).toEqual({
      value: "1 1 0",
      important: true,
    });
    expect(effective(mq600, sel("ToolbarSectionMeta"), "flex")).toEqual({
      value: "0 0 auto",
      important: true,
    });
  });

  test("the title truncates to one line instead of squeezing the avatar (#731, tablet width too)", () => {
    // Without these, "Writing in Media Items collection" wrapped to 4-5 lines
    // beside the local-mode chip and the avatar's section sat on top of it.
    // They live in the 1100px block, not the phone block: at 820px (an iPad
    // in portrait) Decap's single-row desktop toolbar wrapped the same title
    // to four clipped lines and a long label pushed the avatar off screen
    // (UX round 4, triage package 7).
    for (const part of ["BackCollection", "BackStatus"]) {
      const sel = `${TOOLBAR} [class*="${part}"]`;
      expect(effective(mq1100, sel, "white-space")?.value, `${part} white-space`).toBe("nowrap");
      expect(effective(mq1100, sel, "text-overflow")?.value, `${part} text-overflow`).toBe(
        "ellipsis",
      );
      expect(effective(mq1100, sel, "overflow")?.value, `${part} overflow`).toBe("hidden");
    }
    // The unnamed title block is a flex item that refused to shrink below its
    // text; the arrow must not wrap above it at 320px either.
    const block = `${TOOLBAR} [class*="ToolbarSectionBackLink"] > :not([class*="BackArrow"])`;
    // `overflow: hidden` is what lets it shrink (a flex item's automatic
    // minimum size is zero once it clips), so that is the declaration to lock.
    expect(effective(mq1100, block, "overflow")?.value).toBe("hidden");
    expect(effective(mq1100, `${TOOLBAR} [class*="ToolbarSectionBackLink"]`, "flex-wrap")).toEqual({
      value: "nowrap",
      important: true,
    });
  
    // The local-mode chip is 260px of nowrap text; on a tablet row it has to
    // shrink, or it leaves the title 41px and pushes the avatar off screen.
    // Its id selector must stay out of the phone block, where it would beat
    // the chip's `max-width: calc(100% - 20px)`.
    const chip = `${TOOLBAR} > #cms-local-save-indicator`;
    expect(effective(mqTablet, chip, "min-width")?.value, "chip min-width").toBe("0");
    expect(effective(mqTablet, chip, "text-overflow")?.value, "chip text-overflow").toBe("ellipsis");
    expect(effective(mqTablet, chip, "overflow")?.value, "chip overflow").toBe("hidden");
    expect(rulesFor(mq600, chip), "the chip rule must not be in the phone block").toEqual([]);
  });

  test("every toolbar control is a 44px touch target (#731)", () => {
    // Decap's buttons and the back link were 36px tall.
    expect(
      effective(mq600, `${TOOLBAR} [class*="ToolbarSectionBackLink"]`, "min-height")?.value,
    ).toBe("44px");
    for (const sel of [
      `${TOOLBAR} [class*="ToolbarSectionMain"] button`,
      `${TOOLBAR} [class*="ToolbarDropdown"]`,
      `${TOOLBAR} [class*="PublishedToolbarButton"]`,
    ]) {
      expect(effective(mq600, sel, "height")).toEqual({ value: "44px", important: true });
      expect(effective(mq600, sel, "line-height")).toEqual({ value: "44px", important: true });
    }
    for (const part of ["ToolbarSectionMeta", "SettingsWrapper", "AvatarDropdownButton"]) {
      expect(effective(mq600, `${TOOLBAR} [class*="${part}"]`, "height")?.value, part).toBe("44px");
    }
  });

  test("shim chips drop under the buttons instead of taking the title's row (#731)", () => {
    // local-save-indicator.js and deploy-status-pill.js prepend with an inline
    // `order: -1`, which only an !important rule can beat.
    const chip = `${TOOLBAR} > :not([class*="ToolbarSection"])`;
    expect(rulesFor(supports, chip).length, "chip rule inside @supports").toBeGreaterThan(0);
    expect(effective(mq600, chip, "order")).toEqual({ value: "3", important: true });
    // The deploy pills are links, so they keep a 44px target; their `display`
    // must not be !important or it would show a pill that is meant to be hidden.
    const pill = `${TOOLBAR} > a:not([class*="ToolbarSection"])`;
    expect(effective(mq600, pill, "min-height")?.value).toBe("44px");
    expect(effective(mq600, pill, "display")).toEqual({ value: "flex", important: false });
  });

  test("index-local.html's fixed commit / platform pills move off the stuck button row", () => {
    // Their inline `top: 60px / 91px; right: 12px` (z-index 10000) covered the
    // right end of Delete (measured: pill 163-378 x 60-83 over Delete
    // 195-375 x 51-87 at 390px). `:not([style*="bottom"])` skips the
    // production shell's pills, which already set `bottom`.
    for (const [id, minBottom] of [
      ["cms-platform-pill", 4],
      ["cms-commit-pill", 5],
    ]) {
      const sel = `#${id}:not([style*="bottom"])`;
      expect(effective(mq600, sel, "top")).toEqual({ value: "auto", important: true });
      // Clear the Live Preview link (bottom 1.5rem + ~2.4rem tall).
      const bottom = effective(mq600, sel, "bottom")?.value ?? "";
      expect(bottom, `${id} bottom in rem`).toMatch(/^[\d.]+rem$/);
      expect(parseFloat(bottom)).toBeGreaterThanOrEqual(minBottom);
    }
  });

  test("the date control's Now / Clear buttons wrap instead of running off the edge", () => {
    expect(effective(mq768, '[class*="DateTimeControl"]', "flex-wrap")).toEqual({
      value: "wrap",
      important: true,
    });
  });
});
