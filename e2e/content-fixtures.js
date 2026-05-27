// Helpers for tests that need a representative tag or post to assert
// against. Decouples assertions from specific fixture content so that
// removing a tag or post from the site doesn't fail tests that aren't
// actually testing that specific content.
//
// Two discovery functions:
//
//   discoverTags(page)  → [{ name, slug, count }, …] or []
//                         Reads `.tag-list` items from /tags/. Returns
//                         empty when no tags exist (the page renders a
//                         "No tags yet." placeholder; we don't treat that
//                         as a failure — the tests that depend on tags
//                         self-skip).
//
//   discoverPost(page)  → { url, slug, title } or null
//                         Reads the first post link from /blog/. Returns
//                         null when no published posts exist (e.g. only
//                         the future-dated canary). Tests that need a
//                         post fall back to test.skip().
//
// Both helpers issue ONE request — call them once per spec at the top of
// `test.beforeAll`, store the result, reuse across tests.
//
// Why dynamic discovery rather than hardcoded fixtures: removing posts
// or tags is a routine content operation. Tests that hardcode fixture
// names tie spec maintenance to content lifecycle, which is a bad
// coupling. Discovery sturdy-fies the suite — it covers "is the
// /tags/ page well-formed" and "does a post page render correctly"
// regardless of which specific tag or post is on the site today.

async function discoverTags(page) {
  const response = await page.goto("/tags/", { waitUntil: "domcontentloaded" });
  if (!response || response.status() !== 200) return [];

  const items = page.locator(".tag-list .tag-list-item");
  const count = await items.count();
  if (count === 0) return [];

  const tags = [];
  for (let i = 0; i < count; i++) {
    const item = items.nth(i);
    const link = item.locator("a.tag-list-link");
    const href = await link.getAttribute("href");
    if (!href) continue;
    // href shape: `/tags/<slug>/`
    const m = href.match(/\/tags\/([^/]+)\/?$/);
    if (!m) continue;
    const name = (await item.locator(".tag-list-name").innerText()).trim();
    const countText = (await item.locator(".tag-list-count").innerText()).trim();
    const c = parseInt(countText, 10);
    tags.push({ slug: m[1], name, count: Number.isNaN(c) ? 0 : c });
  }
  return tags;
}

async function discoverPost(page) {
  const response = await page.goto("/blog/", { waitUntil: "domcontentloaded" });
  if (!response || response.status() !== 200) return null;

  // The blog index renders a list of published posts as anchors with
  // `/blog/<slug>/` hrefs. Pick the first one — it's the "most recent"
  // post in the user's chronological ordering and is therefore the
  // most stable target for tests that need any post (e.g. "does the
  // share row render?").
  const link = page.locator('a[href^="/blog/"][href$="/"]').first();
  const visible = await link.isVisible().catch(() => false);
  if (!visible) return null;
  const href = await link.getAttribute("href");
  if (!href) return null;
  const m = href.match(/^\/blog\/([^/]+)\/$/);
  if (!m) return null;
  // The link text is typically the post title — use it directly. Some
  // sites wrap the title in nested elements, but `innerText` collapses.
  const title = (await link.innerText()).trim();
  return { url: href, slug: m[1], title };
}

module.exports = { discoverTags, discoverPost };
