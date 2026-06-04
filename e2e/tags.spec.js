// @lane: local — exercises the locally-rendered tag pages; @parity-eligible via TARGET=
const path = require("node:path");
const { test, expect } = require("./base");
const { discoverTags } = require("./content-fixtures");
const cap = require("./site-capabilities");

// SITE_ROOT for the capability gate (same root the harness sits at in a
// consumer; the e2e reusable exports it; the #33 meta-test points it at a
// fixture). Unset → the harness's parent (platform/site root).
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

// Acceptance for issue #27 — make tags functional end-to-end.
//
// Tests are deliberately content-agnostic: they verify the *structure*
// of the tag system (index, archive pages, homepage cloud, empty-state
// placeholder) without depending on which specific tags or posts exist
// at the time the suite runs. The auto-generator's data-shaping is
// covered exhaustively by Ruby unit tests in
// `_plugins_test/auto_tag_pages_test.rb`.
//
// Tag fixtures are discovered at runtime via `discoverTags` rather than
// hardcoded — see e2e/content-fixtures.js. When the site has no tags,
// the per-tag tests self-skip with a clear reason rather than failing.

test.describe("Tags index page", () => {
  // #33 — a single-page consumer that opts out of the tags collection via
  // cms.base_collections (v0.1.7) renders no `/tags/` index (the auto_tag_pages
  // generator only produces it for the tags collection / tagged posts). The
  // "Tag archive pages" + "Homepage tag cloud" describes below already
  // self-skip / handle the no-tags case via discoverTags; only this index
  // describe asserts `/tags/` exists, so guard it precisely. The full
  // fixture-site + adamdaniel.ai keep the tags collection → this runs
  // unchanged there.
  // Keyed on the SOURCE `_config.yml` base_collections (build-INDEPENDENT) so
  // the gate is correct in EVERY lane — including the preview/prod @parity
  // crawls that hit deployed surfaces and never build `_site` (a rendered-
  // config check would wrongly skip a full consumer there).
  test.beforeEach(() => {
    test.skip(
      !cap.keepsBaseCollection(SITE_ROOT, "tags"),
      "consumer opts out of the tags collection via cms.base_collections — no /tags/ index to assert (#33)",
    );
  });

  test("/tags/ exists and renders without errors", async ({ page }) => {
    const response = await page.goto("/tags/");
    expect(response.status()).toBe(200);

    await expect(page.locator(".page-header h1", { hasText: /^Tags$/i })).toBeVisible();
  });

  test("/tags/ either lists tags or shows the empty placeholder", async ({ page }) => {
    await page.goto("/tags/");
    // Two valid renderings: a non-empty `.tag-list`, or the
    // "No tags yet." paragraph. A site mid-deletion shouldn't render
    // an empty `.tag-list` shell.
    const list = page.locator(".tag-list");
    const placeholder = page.locator("text=/no tags yet/i");
    const listVisible = await list.isVisible();
    const placeholderVisible = await placeholder.isVisible();
    expect(
      listVisible || placeholderVisible,
      "expected either a populated .tag-list or the 'No tags yet.' placeholder",
    ).toBe(true);
    if (listVisible) {
      // If the list is shown, it must have at least one item — an
      // empty .tag-list shell is the failure mode this asserts against.
      const items = await list.locator(".tag-list-item").count();
      expect(items).toBeGreaterThan(0);
    }
  });
});

test.describe("Tag archive pages", () => {
  test("each discovered tag's /tags/<slug>/ resolves with the right header", async ({ page }) => {
    const tags = await discoverTags(page);
    test.skip(tags.length === 0, "no tags exist on the site — nothing to assert against");
    for (const { name, slug } of tags) {
      const response = await page.goto(`/tags/${slug}/`);
      expect(response.status(), `/tags/${slug}/ should respond 200`).toBe(200);
      await expect(page.locator(".page-header h1")).toHaveText(name);
    }
  });

  test("a tag with no matching posts shows the empty-state placeholder", async ({ page }) => {
    // Find a tag with count 0 (a curated tag entry that no post
    // currently references). Its archive should render the
    // "No posts yet" placeholder, not a broken empty list.
    const tags = await discoverTags(page);
    const zero = tags.find((t) => t.count === 0);
    test.skip(
      !zero,
      "no zero-count tag available — every visible tag is referenced by at least one post",
    );

    await page.goto(`/tags/${zero.slug}/`);
    await expect(page.locator("text=/no posts yet/i")).toBeVisible();
  });
});

test.describe("Homepage tag cloud", () => {
  test("landing page shows a tag list at the bottom OR omits the section when there are no tags", async ({
    page,
  }) => {
    const tags = await discoverTags(page);

    await page.goto("/");
    const section = page.locator(".tag-cloud-section");
    const sectionVisible = await section.isVisible();

    if (tags.length === 0) {
      // No tags → the section can either render an empty cloud or be
      // omitted entirely. Either is acceptable; what's NOT acceptable
      // is a section visible with broken (zero-pill) cloud markup.
      if (sectionVisible) {
        const cloud = section.locator(".tag-cloud");
        const cloudVisible = await cloud.isVisible();
        if (cloudVisible) {
          const pills = await cloud.locator("a").count();
          expect(
            pills,
            "tag-cloud rendered but contains no pills — should hide the section instead",
          ).toBeGreaterThan(0);
        }
      }
      return;
    }

    expect(sectionVisible, "homepage should show .tag-cloud-section when tags exist").toBe(true);
    await expect(section.locator('a[href$="/tags/"]')).toBeVisible();

    const cloud = section.locator(".tag-cloud");
    await expect(cloud).toBeVisible();
    for (const { slug } of tags) {
      await expect(cloud.locator(`a[href$="/tags/${slug}/"]`)).toBeVisible();
    }
  });
});
