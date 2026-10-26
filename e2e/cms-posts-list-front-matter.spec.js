// @lane: local — uses the in-browser test-repo backend (admin/index-test.html); no real GitHub
const { test, expect } = require("./base");
const { loadTestAdmin } = require("./cms-test-backend");

// The Posts list links each post at the address Jekyll serves it at, which
// takes `:slug` from the front-matter `slug:` when one is set, not from the
// file name (adamdaniel.ai#4137: the list linked a post at a 404). Decap hands
// the list no front matter, so the posts `summary:` template carries the entry's
// `slug`/`permalink` after U+2063 and admin/posts-list-enhance.js strips them
// off the card title. This spec drives the REAL Decap bundle, because the
// heading's shape decides whether the strip works: Decap 3.15.1 renders
// [summary text, <TitleIcons>] — two children — and a strip written for a
// one-child heading left the slug visible in every title (cms-platform, review
// of the front-matter-slug fix).
//
// Seeded through `window.repoFiles` like cms-editorial-mode.spec.js; the shell
// is admin/index-test.html, whose config-test.yml is fixed (never opted out by a
// consumer's base_collections), so this spec is not guarded.

const CARRIER = "⁣";
// `li`: index-test.html's static "open Replacement test post 1" hint also links
// an entry, outside the list.
const ENTRY_LINKS = 'li a[href*="#/collections/posts/entries/"]';
// Decap's "+ New" button: on a collection list, absent from the entry editor.
const NEW_BUTTON = '[class*="CollectionTopNewButton"]';

const post = (title, slug, published) =>
  [
    "---",
    `title: ${title}`,
    `slug: '${slug}'`,
    "date: 2026-03-01 09:00:00 -0400",
    "excerpt: ''",
    "tags: []",
    "featured_image: ''",
    `published: ${published}`,
    "publish_date: ''",
    "reading_time: null",
    "---",
    "",
    "Body",
    "",
  ].join("\n");

const SEED = {
  repoFiles: {
    _posts: {
      "2026-03-01-no-slug.md": { content: post("No slug post", "", true) },
      "2026-03-02-file-name-differs.md": { content: post("Slug differs post", "front-matter-slug-wins", true) },
      "2026-03-03-draft-with-slug.md": { content: post("Draft with slug", "draft-front-matter-slug", false) },
    },
    _tags: {},
    _projects: {},
    pages: {},
  },
  repoFilesUnpublished: [],
};

// Stand on the Posts list without reloading. loadTestAdmin leaves Decap on that
// list, so `page.goto("/admin/index-test.html#/collections/posts")` is a full
// reload whose first paint starts single-entry-collection-shortcut.js's 700 ms
// settle timer before Decap has rendered. On a slow runner (webkit-iphone16) the
// timer finds only index-test.html's static "open Replacement test post 1" link
// with no "+ New" link beside it, takes the collection for a singleton and jumps
// into an entry that is not seeded, so the list never renders. Wait for the list
// Decap rendered itself (its "+ New" button is what the shim checks for), then
// pin the route by hash: a hash already equal to it starts no timer. Same fix as
// cms-route-focus.spec.js and cms-admin-focus-ring.spec.js.
async function openPostsList(page) {
  await expect(page.locator(NEW_BUTTON)).toBeVisible({ timeout: 60_000 });
  await page.evaluate(() => {
    location.hash = "#/collections/posts";
  });
  await expect(page.locator(NEW_BUTTON)).toBeVisible();
}

// What an editor SEES in each card's title (innerText, not textContent).
async function visibleTitles(page) {
  await expect(page.locator(ENTRY_LINKS)).toHaveCount(3, { timeout: 60_000 });
  return page.locator(`${ENTRY_LINKS} h2`).allInnerTexts();
}

function expectNoCarriedFrontMatter(titles) {
  for (const t of titles) {
    expect(t, `title "${t}" must not show the carried front matter`).not.toContain(CARRIER);
    expect(t).not.toContain("front-matter-slug-wins");
    expect(t).not.toContain("draft-front-matter-slug");
  }
}

test.describe(
  "Posts list: front-matter slug on the real Decap bundle",
  // Tagged @admin-read: drives /admin/* but is read-only. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 180_000 });

    test("the list's titles carry no slug, and each post is linked at its Jekyll address", async ({ page }) => {
      await loadTestAdmin(page, { seed: SEED });
      await openPostsList(page);

      const titles = await visibleTitles(page);
      expectNoCarriedFrontMatter(titles);
      expect(titles).toEqual(expect.arrayContaining(["No slug post", "Slug differs post", "Draft with slug"]));

      const hrefOf = (file) =>
        page
          .locator(`li:has(a[href$="/entries/${file}"]) a[target="_blank"]`)
          .filter({ hasText: "published" })
          .getAttribute("href");
      expect(await hrefOf("2026-03-02-file-name-differs")).toMatch(/\/blog\/front-matter-slug-wins\/$/);
      expect(await hrefOf("2026-03-01-no-slug")).toMatch(/\/blog\/no-slug\/$/);
    });

    test("global search results show no slug either, and keep the DRAFT mark", async ({ page }) => {
      await loadTestAdmin(page, { seed: SEED });
      await page.goto("/admin/index-test.html#/search/slug");

      const titles = await visibleTitles(page);
      expectNoCarriedFrontMatter(titles);
      // Search has no status chip, so the suffix is the only place DRAFT shows.
      expect(titles).toContain("Draft with slug — DRAFT");
    });
  },
);
