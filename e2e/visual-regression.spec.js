// @lane: local — structural smoke checks for representative public pages
const { test, expect } = require("./base");
const { discoverPost, discoverTags } = require("./content-fixtures");

// Structural ("does it render?") smoke checks for the representative
// public surfaces. The pixel-level `toHaveScreenshot` baselines that used
// to live here were retired (#86): their committed PNGs were deleted on
// 2026-05-06 and never regenerated, so the suite only stayed green by
// skipping — and the first real curated tag in prod un-skipped the tag
// pages and hard-failed on a baseline that was never committed.
//
// Pixel-level visual regression is handled by the video pipeline
// (visual-regression.yml -> regression-video.spec.js) on SALIENT PRs: it
// diffs each PR screenshot against the *production* screenshot of the same
// page, machine-classifies identical/different/new (compute-visual-diffs.js),
// and escalates only the machine-flagged diffs to the required
// `regression-review` merge gate — no committed PNGs to drift.
//
// These structural checks are net-additive: they keep the SAME
// content-discovery skip-guards the pixel tests used (so they still skip
// cleanly on a base_collections:[] bio — the #33 contract), run on ALL
// public projects and on content-only PRs, and only assert each surface
// returns a non-error status and renders real content — catching a
// 500 / blank render the salient-only pixel pipeline would miss.

// Assert a public URL renders: non-error status + a visible heading
// (a 500 / blank page has neither).
async function expectRenders(page, url) {
  const resp = await page.goto(url);
  expect(resp, `no response navigating to ${url}`).not.toBeNull();
  expect(
    resp.status(),
    `${url} returned ${resp.status()} — expected a non-error status`,
  ).toBeLessThan(400);
  await expect(
    page.getByRole("heading").first(),
    `${url} rendered no visible heading — likely a broken/blank page`,
  ).toBeVisible();
}

test.describe("Visual regression (structural smoke)", () => {
  test("homepage renders", async ({ page }) => {
    // Guarded on a published post like the rest of this suite so it skips
    // cleanly on a base_collections:[] bio (#33): without posts the
    // homepage is a different (bio) layout the content specs don't own.
    const post = await discoverPost(page);
    test.skip(!post, "no published posts → bio-shaped homepage, covered by other specs");
    await expectRenders(page, "/");
  });

  test("blog post renders", async ({ page }) => {
    const post = await discoverPost(page);
    test.skip(!post, "no published posts to navigate to");
    await expectRenders(page, post.url);
  });

  test("tags index renders", async ({ page }) => {
    // Filter out transient e2e-fixture tags so this mirrors curated
    // production content; skip when none exist (a bio has no /tags/).
    const stableTags = (await discoverTags(page)).filter((t) => !t.slug.startsWith("e2e-"));
    test.skip(
      stableTags.length === 0,
      "no curated (non-e2e-fixture) tags → /tags/ is not generated",
    );
    await expectRenders(page, "/tags/");
  });

  test("tag archive renders", async ({ page }) => {
    const stableTags = (await discoverTags(page)).filter((t) => !t.slug.startsWith("e2e-"));
    test.skip(
      stableTags.length === 0,
      "no curated (non-e2e-fixture) tags → no stable archive page to render",
    );
    await expectRenders(page, `/tags/${stableTags[0].slug}/`);
  });
});

// Admin (Decap CMS) visual baselines were retired with the cobalt-thermal
// theme; the page-level pixel baselines that lived here were retired in #86
// (see the header). Visual drift is now covered by the prod-diffing video
// pipeline; the data plane is covered by cms-smoke.spec.js (load / save /
// delete round-trips, field render + contrast asserts) and
// cms-editorial-workflow.spec.js (editor against the test-repo backend, no
// read-only widgets, edit -> save round-trip).
