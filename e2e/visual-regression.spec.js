// @lane: local — captures locally-rendered pages for the visual-regression baseline
const { test, expect } = require("./base");
const { discoverPost, discoverTags } = require("./content-fixtures");

// Pixel-level baselines for representative pages. Tests use
// `discoverPost` / `discoverTags` to find a real fixture; when the
// site has no published posts or no tags, the dependent tests skip
// with a clear reason rather than failing on a pinned snapshot for
// removed content.
//
// When content reappears, snapshots regenerate via:
//   npx playwright test e2e/visual-regression.spec.js --update-snapshots
//
// The snapshot filename incorporates the discovered slug so that two
// posts in the same suite would produce distinct baselines if the
// fixtures changed underfoot — a single canonical name like
// `blog-post.png` would conflate them.

// Freeze all CSS animations for deterministic screenshots.
const FREEZE_ANIMATIONS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    animation-delay: -4s !important;
    transition-duration: 0s !important;
  }
`;

test.describe("Visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await page.addStyleTag({ content: FREEZE_ANIMATIONS });
  });

  test("homepage", async ({ page }) => {
    // The homepage's "Latest Posts" section only renders when posts
    // exist; without posts, the page differs structurally enough that
    // a pinned snapshot would never match. Skip when empty.
    const post = await discoverPost(page);
    test.skip(
      !post,
      "no published posts → homepage 'Latest Posts' section empty; baseline would be of a different layout",
    );

    await page.goto("/");
    await page.addStyleTag({ content: FREEZE_ANIMATIONS });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("homepage.png");
  });

  test("blog post", async ({ page }) => {
    const post = await discoverPost(page);
    test.skip(!post, "no published posts to capture");

    await page.goto(post.url);
    await page.addStyleTag({ content: FREEZE_ANIMATIONS });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot(`blog-post-${post.slug}.png`);
  });

  test("tags index", async ({ page }) => {
    // Skip when no tags OR only transient e2e-fixture tags exist —
    // /tags/ renders the 'No tags yet.' placeholder, which is a
    // different layout from a populated index, AND fixture tags from
    // local-backend specs (cms-smoke creates _tags/e2e-smoke-flow-tag,
    // etc.) make the captured page non-deterministic across runs.
    // The snapshot baseline only makes sense when /tags/ is in its
    // steady-state production layout with curated content.
    const stableTags = (await discoverTags(page)).filter((t) => !t.slug.startsWith("e2e-"));
    test.skip(
      stableTags.length === 0,
      "no curated (non-e2e-fixture) tags on the site → /tags/ layout is non-deterministic; baseline would shift between runs",
    );

    await page.goto("/tags/");
    await page.addStyleTag({ content: FREEZE_ANIMATIONS });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot("tags-index.png");
  });

  test("tag archive", async ({ page }) => {
    // Same reason as "tags index": filter out e2e-fixture tags so the
    // captured /tags/<slug>/ page corresponds to curated production
    // content, not whatever cms-smoke / cms-publish-flow happened to
    // seed in _tags/ during this run. Run #25504778037 caught this:
    // the test captured `tag-archive-e2e-smoke-flow-tag-...png`, a
    // baseline that never gets committed to source because the tag
    // is transient.
    const stableTags = (await discoverTags(page)).filter((t) => !t.slug.startsWith("e2e-"));
    test.skip(
      stableTags.length === 0,
      "no curated (non-e2e-fixture) tags → no stable archive page to capture",
    );

    const slug = stableTags[0].slug;
    await page.goto(`/tags/${slug}/`);
    await page.addStyleTag({ content: FREEZE_ANIMATIONS });
    await page.waitForTimeout(200);
    await expect(page).toHaveScreenshot(`tag-archive-${slug}.png`);
  });
});

// Admin (Decap CMS) visual baselines were retired together with the
// cobalt-thermal theme — there is no theme to drift now, and the
// editor's WYSIWYG surface is /preview/?collection=<n> rather than
// the form itself. The data plane is still covered:
//
//   - cms-smoke.spec.js exercises load / save / delete round-trips
//     through decap-server and asserts every Posts field renders
//     with content + non-zero box + foreground/background contrast.
//   - cms-editorial-workflow.spec.js drives the editor against the
//     test-repo backend with editorial workflow on, asserts no
//     widget renders read-only, and round-trips edit → save into a
//     workflow draft.
//
// If the admin needs custom styling again in the future, restore an
// equivalent describe block here AND commit fresh baselines in
// e2e/visual-regression.spec.js-snapshots/.
