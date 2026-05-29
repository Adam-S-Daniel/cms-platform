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
      const describe = (n) => {
        if (!n) return "null";
        const cls =
          typeof n.className === "string"
            ? n.className
            : (n.className && n.className.baseVal) || "";
        return (
          n.tagName.toLowerCase() +
          (cls ? "." + String(cls).trim().split(/\s+/).join(".").slice(0, 40) : "")
        );
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

module.exports = { expectReachable };
