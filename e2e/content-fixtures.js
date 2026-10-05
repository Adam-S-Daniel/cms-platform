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
//                         Reads the first post permalink from /blog/
//                         (skipping the nav's own /blog/ link). Returns
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

// Pure: pick the first real post permalink from a page's anchors, given as
// `[{ href, text }]` in DOM order. A post permalink is exactly one segment
// under /blog/ (`/blog/<slug>/`, the `permalink: /blog/:slug/` both
// consumers and the fixture use). The blog index is NOT one: every
// default-layout page carries the site nav's `/blog/` link BEFORE the post
// list, and `/blog/` matches `^/blog/` + `/$` — so a bare prefix/suffix
// selector grabbed the nav link first and the slug match then failed, making
// every test that needs a post skip with "no published posts". The slug
// segment must be non-empty, and a paginator's `/blog/page<N>/` listing page
// is not a post either.
function pickPostLink(anchors) {
  for (const { href, text } of anchors) {
    if (!href) continue;
    const m = href.match(/^\/blog\/([^/?#]+)\/$/);
    if (!m) continue;
    if (/^page\d*$/i.test(m[1])) continue;
    return { url: href, slug: m[1], title: (text || "").trim() };
  }
  return null;
}

async function discoverPost(page) {
  const response = await page.goto("/blog/", { waitUntil: "domcontentloaded" });
  if (!response || response.status() !== 200) return null;

  // The blog index renders its published posts as anchors, newest first, but
  // the site header's nav link to the index itself comes earlier in the DOM —
  // so collect every anchor and let `pickPostLink` skip non-posts. The first
  // real post is the "most recent" one and the most stable target for tests
  // that need any post (e.g. "does the share row render?"). The link text is
  // typically the post title; `innerText` collapses nested elements.
  const anchors = await page.$$eval("a[href]", (els) =>
    els.map((a) => ({ href: a.getAttribute("href"), text: a.innerText })),
  );
  return pickPostLink(anchors);
}

module.exports = { discoverTags, discoverPost, pickPostLink };
