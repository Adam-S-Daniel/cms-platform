// Shared UI-visibility assertions for admin (and other UI) specs.
//
// A passing `toBeVisible()` only proves an element has non-zero size and
// isn't display:none/visibility:hidden/opacity:0 — it does NOT prove the
// element is actually usable. Two failure modes slip past it and have
// shipped real regressions in this repo's Decap admin:
//
//   1. Clipped off-screen — the element renders past the viewport edge
//      (e.g. a toolbar/modal button that overflows to the right on a
//      phone). It's "visible" to Playwright but the user can't reach it.
//   2. Occluded — another element paints on top of it (e.g. a wrapped
//      button row rendered behind the asset grid in the media-library
//      modal). Again "visible", but covered and un-clickable.
//
// `expectReachable` catches both: the element must sit within the
// viewport horizontally and, at its center point, be the topmost element
// (`document.elementFromPoint`) — i.e. nothing covers it.
//
// Use it in admin/* UI specs for the controls a user must be able to tap
// (Save / Publish / Delete, "New <entry>", media-library actions, …),
// and run those specs on BOTH admin resolutions (chromium-desktop-3k and
// webkit-iphone16) so a regression at either size fails the build.

const { expect } = require("@playwright/test");

/**
 * Assert that a control is genuinely reachable: visible, within the
 * viewport horizontally, and not covered by another element at its
 * center point. Scrolls the element into view first so below-the-fold
 * controls are probed where they actually live.
 *
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} locator
 * @param {string} label  Human-readable name for failure messages.
 */
async function expectReachable(page, locator, label) {
  await expect(locator, `${label}: not visible`).toBeVisible();
  await locator.scrollIntoViewIfNeeded().catch((err) => {
    // Best-effort pre-scroll: the element can detach mid-scroll (a React
    // re-mount), but the reachability poll below re-acquires the handle
    // each iteration, so a failed pre-scroll is not fatal. Surface it at
    // debug level rather than swallowing it silently.
    console.debug(`expectReachable: scroll skipped (${err.message})`);
  });

  // Poll the geometry + occlusion probe: a transient layout (mid-React
  // render, an editor still showing "Loading entry…") shouldn't flake the
  // check, but a persistent clip/occlusion still fails after the timeout.
  // Re-acquire the element handle each iteration so a React re-mount
  // doesn't leave us probing a detached node.
  await expect(async () => {
    const handle = await locator.elementHandle();
    expect(handle, `${label}: not attached to the DOM`).toBeTruthy();
    const res = await page.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const hit = document.elementFromPoint(cx, cy);
      // Describe a node well enough to ACT on the failure. A bare tag name
      // is not enough: decap's icons are unclassed inline `<svg>`s inside
      // Emotion-styled wrappers, so an occlusion report of "hidden behind
      // <svg>" names thousands of candidate elements and can't distinguish
      // "a real overlay covers the control" from "the control's own icon".
      // Diagnosing one such failure cost a full CI cycle plus a local
      // bisect. So walk UP to the nearest classed ancestors and strip
      // Emotion's rotating `css-<hash>-` prefix, leaving the stable
      // component labels (`IconWrapper`, `ActionButton`, `LibraryTop`, …).
      const describe = (n) => {
        if (!n) return "null";
        const parts = [];
        for (let e = n; e && e.tagName && parts.length < 4; e = e.parentElement) {
          const cls =
            typeof e.className === "string" ? e.className : (e.className && e.className.baseVal) || "";
          const names = String(cls)
            .trim()
            .split(/\s+/)
            .filter(Boolean)
            .map((c) => c.replace(/^css-[a-z0-9]+-/, ""))
            .filter((c) => !/^css-[a-z0-9]+$/.test(c))
            .join(".");
          parts.push(e.tagName.toLowerCase() + (names ? "." + names.slice(0, 60) : ""));
          if (names) break;
        }
        return parts.join(" < ");
      };
      return {
        vw: window.innerWidth,
        left: Math.round(r.left),
        right: Math.round(r.right),
        // elementFromPoint returns the topmost element at the point; the
        // control is unoccluded iff that's the control itself, a
        // descendant (inner <span>/<svg>), or an ancestor that wraps it.
        occluded: !(hit && (el === hit || el.contains(hit) || hit.contains(el))),
        occluder: describe(hit),
      };
    }, handle);
    await handle.dispose();

    expect(
      res.left,
      `${label}: clipped off the LEFT edge (left=${res.left})`,
    ).toBeGreaterThanOrEqual(-1);
    expect(
      res.right,
      `${label}: clipped off the RIGHT edge (right=${res.right} > viewport ${res.vw})`,
    ).toBeLessThanOrEqual(res.vw + 1);
    expect(
      res.occluded,
      `${label}: hidden behind <${res.occluder}> — the control is covered by another element`,
    ).toBe(false);
  }).toPass({ timeout: 15_000, intervals: [200, 500, 1000, 2000] });
}

/**
 * Assert that nothing this admin INJECTS geometrically overlaps a control.
 *
 * `expectReachable` above is a HIT test — `document.elementFromPoint` at the
 * control's centre. That is the right question for "can the user click it",
 * and the wrong one for "can the user read it": an overlay carrying
 * `pointer-events: none` is invisible to `elementFromPoint`, so a banner can
 * paint straight over a button's label and the hit test still returns the
 * button.
 *
 * That is not hypothetical. `theme/admin/publish-step-hint.js` shipped as a
 * `position: fixed`, top-centre, `pointer-events: none` notice and covered
 * 68% of the Publish button and 47% of the Status control it was pointing at
 * (measured on a live Decap 3.15.1 at 1280x800, reported with a screenshot).
 * Every occlusion assertion in this repo stayed green for the whole time it
 * was on production, because they all asked the clickability question.
 *
 * So this asks the geometric one: for every element the platform adds to
 * Decap's DOM, its rectangle must not intersect any named control's
 * rectangle. Containment is exempt in both directions — an injected pill that
 * lives INSIDE the toolbar is in flow, and a control's own icon is a
 * descendant, neither of which is an overlay.
 *
 * "Injected by the platform" is `id^="cms-"` (the namespace every admin shim
 * uses) plus the two floating chrome links from the shells. It deliberately
 * does not try to enumerate individual shims: the point is to catch the NEXT
 * one, not to re-list the ones that exist today.
 *
 * @param {import('@playwright/test').Page} page
 * @param {Record<string,string>} controls  label → CSS selector for each
 *   control that must stay legible.
 */
async function expectNoInjectedOverlap(page, controls) {
  const offenders = await page.evaluate((sel) => {
    const INJECTED = '[id^="cms-"], #live-preview-link, #reviews-link';
    const strip = (c) =>
      String((c && c.baseVal) || c || "")
        .trim()
        .split(/\s+/)
        .map((x) => x.replace(/^css-[a-z0-9]+-/, ""))
        .filter((x) => x && !/^css-[a-z0-9]+$/.test(x))
        .join(".");
    const out = [];
    for (const [label, selector] of Object.entries(sel)) {
      const control = document.querySelector(selector);
      if (!control) continue;
      const rb = control.getBoundingClientRect();
      if (!rb.width || !rb.height) continue;
      for (const overlay of document.querySelectorAll(INJECTED)) {
        // In flow inside the control's subtree (or wrapping it) is not an
        // overlay — only a genuinely separate box painting on top is.
        if (overlay.contains(control) || control.contains(overlay)) continue;
        const style = getComputedStyle(overlay);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const ra = overlay.getBoundingClientRect();
        if (!ra.width || !ra.height) continue;
        const ox = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
        const oy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
        const area = Math.round(ox * oy);
        if (area > 0) {
          out.push({
            control: label,
            overlay: overlay.id || strip(overlay.className) || overlay.tagName,
            overlapPx: area,
            pctOfControl: Math.round((area / (rb.width * rb.height)) * 100),
            pointerEvents: style.pointerEvents,
            position: style.position,
          });
        }
      }
    }
    return out;
  }, controls);

  expect(
    offenders,
    "an element this admin injects is painting over a control the editor has to " +
      "read. A `pointer-events: none` overlay passes every hit test in this file " +
      "and is still unreadable — put the element in normal flow instead:\n" +
      JSON.stringify(offenders, null, 2),
  ).toEqual([]);
}

module.exports = { expectReachable, expectNoInjectedOverlap };

