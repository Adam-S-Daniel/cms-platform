// @lane: local — pure logic unit test; no browser, no network, no wall-clock.
// Only requires ./content-fixtures (a harness-local module), so it is NOT a
// PLATFORM_META_SPEC.
//
// Locks `pickPostLink`, the selection rule behind `discoverPost`. The first
// version selected `a[href^="/blog/"][href$="/"]`, which matches the site
// nav's own `/blog/` link (it precedes the post list on every
// default-layout page); the slug match then failed on it and returned null,
// so every test that needs a post (share row, blog post, feed content)
// skipped with "no published posts" on the fixture site and on real sites.
const { test, expect } = require("./base");
const { pickPostLink } = require("./content-fixtures");

// Lexical token extraction only (`<a ... href="...">text</a>`): the helper
// under test receives `[{ href, text }]` from the browser, and this turns the
// rendered blog index markup of a site into that shape.
function anchorsFromHtml(html) {
  const out = [];
  const re = /<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    out.push({ href: m[1], text: m[2].replace(/<[^>]*>/g, "") });
  }
  return out;
}

// The rendered shape of /blog/ from e2e/fixture-site (and, with extra
// elements, adamdaniel.ai): header nav first, then the post list.
const BLOG_INDEX_HTML = `
<header class="site-header"><div class="container">
  <a class="site-logo" href="/">Fixture Site</a>
  <nav class="site-nav" aria-label="Main navigation">
    <a href="/blog/" class="active">Blog</a>
  </nav>
</div></header>
<main id="main-content"><div class="container">
  <h1>Blog</h1>
  <a class="feed-link" href="/feed.xml">Subscribe</a>
  <ul class="post-list">
    <li class="post-item">
      <h3 class="post-title"><a href="/blog/hello-world/">Hello, World</a></h3>
      <div class="post-tags"><a class="tag-pill" href="/tags/welcome/">welcome</a></div>
    </li>
  </ul>
</div></main>`;

test("skips the nav's /blog/ link and returns the first real post", () => {
  expect(pickPostLink(anchorsFromHtml(BLOG_INDEX_HTML))).toEqual({
    url: "/blog/hello-world/",
    slug: "hello-world",
    title: "Hello, World",
  });
});

test("returns the first post in DOM order when several are listed", () => {
  const html = `${BLOG_INDEX_HTML}
    <h3 class="post-title"><a href="/blog/older-post/">Older</a></h3>`;
  expect(pickPostLink(anchorsFromHtml(html)).slug).toBe("hello-world");
});

test("returns null when the page lists no posts (nav, tags and feed links only)", () => {
  const html = `
    <a href="/">Home</a><a href="/blog/">Blog</a>
    <a href="/tags/">Tags</a><a href="/tags/welcome/">welcome</a>
    <a href="/feed.xml">Feed</a><a href="/blog/page2/">Older</a>
    <a href="/blog/page/2/">Older</a><a href="https://example.com/blog/x/">x</a>`;
  expect(pickPostLink(anchorsFromHtml(html))).toBeNull();
});

test("ignores listing and non-permalink shapes under /blog/", () => {
  for (const href of [
    "/blog/",
    "/blog",
    "/blog//",
    "/blog/page2/",
    "/blog/page/",
    "/blog/page/2/",
    "/blog/tags/x/",
    "/blog/hello-world/#comments",
    "/blog/hello-world/?utm=x",
    "/blog/hello-world",
    "",
  ]) {
    expect(pickPostLink([{ href, text: "t" }]), `href ${JSON.stringify(href)}`).toBeNull();
  }
  expect(pickPostLink([{ href: null, text: "t" }])).toBeNull();
  expect(pickPostLink([])).toBeNull();
});

test("accepts a slug that merely starts with 'page' and percent-encoded slugs", () => {
  expect(pickPostLink([{ href: "/blog/pages-of-history/", text: "x" }]).slug).toBe(
    "pages-of-history",
  );
  expect(pickPostLink([{ href: "/blog/quoting-anthropic%E2%80%99s-note/", text: " T " }])).toEqual({
    url: "/blog/quoting-anthropic%E2%80%99s-note/",
    slug: "quoting-anthropic%E2%80%99s-note",
    title: "T",
  });
});
