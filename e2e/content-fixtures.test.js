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
const {
  pickPostLink,
  decodeEntities,
  normalizeTitle,
  feedHasTitle,
  hrefParamStartsWith,
  visibleTitleLocator,
  discoverTags,
  duplicateTagSlugs,
} = require("./content-fixtures");

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

// ── Titles with quotes, ampersands and angle brackets ───────────────────────
// `discoverPost().title` is the anchor's rendered text; the specs compare it
// against the feed, the share-intent hrefs and the post page. Each of those
// spells it differently, so a title like `Q&A: "Don't <stop>"` used to break
// the consuming specs (selector parse error, regex never matching the
// escaped/smartified feed text, a share-intent word that is percent-encoded).
// Real titles already carry curly quotes (adamdaniel.ai posts).

const TITLES = [
  'He said "hi"',
  "Don't stop",
  "Q&A time",
  "Less < more",
  "Quoting Anthropic\u2019s \u201Csomewhat less robust\u201D",
  'Q&A: "Don\'t <stop>"',
];

test("pickPostLink keeps the rendered title text verbatim for special characters", () => {
  for (const title of TITLES) {
    expect(pickPostLink([{ href: "/blog/x/", text: `  ${title} ` }]).title).toBe(title);
  }
});

test("decodeEntities decodes once, named and numeric", () => {
  expect(decodeEntities("A &amp; B &lt;i&gt; &quot;q&quot; it&#39;s &#x2019;")).toBe(
    "A & B <i> \"q\" it's \u2019",
  );
  expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  expect(decodeEntities("&bogus; &#0; &#x110000;")).toBe("&bogus; &#0; &#x110000;");
});

test("normalizeTitle folds smartify typography on either side", () => {
  expect(normalizeTitle("Don\u2019t \u201Cstop\u201D")).toBe(normalizeTitle(`Don't "stop"`));
  expect(normalizeTitle("a -- b --- c ... d")).toBe(normalizeTitle("a \u2013 b \u2014 c \u2026 d"));
  expect(normalizeTitle("  a \n  b ")).toBe("a b");
});

// jekyll-feed 0.17.0 renders `smartify | strip_html | normalize_whitespace |
// xml_escape` into `<title type="html">`; smartify HTML-escapes `&` and `<`
// first, so xml_escape escapes them a second time. These strings are what
// that pipeline emitted for the titles above (checked with Jekyll 4.4.1).
const FEED_SPELLINGS = {
  'He said "hi"': "He said \u201Chi\u201D",
  "Don't stop": "Don\u2019t stop",
  "Q&A time": "Q&amp;amp;A time",
  "Less < more": "Less &amp;lt; more",
  "Quoting Anthropic\u2019s \u201Csomewhat less robust\u201D":
    "Quoting Anthropic\u2019s \u201Csomewhat less robust\u201D",
  'Q&A: "Don\'t <stop>"': null, // strip_html drops `<stop>`; covered separately below
};

function feedWith(titleHtml) {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Fixture Site</title>
  <entry><title type="html">${titleHtml}</title><link href="/blog/x/"/></entry></feed>`;
}

test("feedHasTitle matches the smartified, entity-escaped feed spelling", () => {
  for (const [title, spelled] of Object.entries(FEED_SPELLINGS)) {
    if (spelled === null) continue;
    expect(feedHasTitle(feedWith(spelled), title), `title ${JSON.stringify(title)}`).toBe(true);
  }
});

test("feedHasTitle also matches plain single- and unescaped spellings", () => {
  expect(feedHasTitle(feedWith("Q&amp;A time"), "Q&A time")).toBe(true);
  expect(feedHasTitle(feedWith("He said &quot;hi&quot;"), 'He said "hi"')).toBe(true);
  expect(feedHasTitle(feedWith("Don&#39;t stop"), "Don't stop")).toBe(true);
  expect(feedHasTitle(feedWith("<![CDATA[Q&A time]]>"), "Q&A time")).toBe(true);
});

test("feedHasTitle is false for an absent title, an empty title and a non-title element", () => {
  expect(feedHasTitle(feedWith("Something else"), "Q&A time")).toBe(false);
  expect(feedHasTitle(feedWith("Anything"), "")).toBe(false);
  expect(feedHasTitle("<feed><summary>Q&amp;A time</summary></feed>", "Q&A time")).toBe(false);
});

// Regression: feedHasTitle once scanned every <title> with a substring test.
// Red on the old code: the first three passed on the feed's own site title or
// a longer entry title; the fourth passed on a <title> in an entry's body.
test("feedHasTitle ignores the feed's own site title (a post titled like the site is not proven)", () => {
  const siteOnly = `<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">Adam Daniel</title>
  <entry><title type="html">Something else</title><link href="/blog/x/"/></entry></feed>`;
  expect(feedHasTitle(siteOnly, "Adam")).toBe(false);
  expect(feedHasTitle(siteOnly, "Adam Daniel")).toBe(false);
  // The same feed with the entry actually titled "Adam" does pass.
  expect(feedHasTitle(feedWith("Adam"), "Adam")).toBe(true);
});

test("feedHasTitle needs the FULL entry title, not a substring of it", () => {
  expect(feedHasTitle(feedWith("Notes on shipping"), "Notes")).toBe(false);
  expect(feedHasTitle(feedWith("Notes on shipping"), "on shipping")).toBe(false);
  expect(feedHasTitle(feedWith("Notes on shipping"), "Notes on shipping")).toBe(true);
  // Case is not folded: the feed carries the title's case unchanged.
  expect(feedHasTitle(feedWith("Notes on shipping"), "notes on shipping")).toBe(false);
});

test("feedHasTitle reads each entry's own title and skips a <title> inside its body", () => {
  const body = `<feed><title>Site</title>
  <entry><title type="html">First post</title>
    <content type="html"><![CDATA[<title>Hidden gem</title>]]></content></entry>
  <entry><title type="html">Second post</title></entry></feed>`;
  expect(feedHasTitle(body, "First post")).toBe(true);
  expect(feedHasTitle(body, "Second post")).toBe(true);
  expect(feedHasTitle(body, "Hidden gem")).toBe(false);
  expect(feedHasTitle(body, "Site")).toBe(false);
});

test("feedHasTitle reads RSS <item> titles and not the channel title", () => {
  const rss = `<rss><channel><title>Channel</title>
  <item><title>Item one</title></item></channel></rss>`;
  expect(feedHasTitle(rss, "Item one")).toBe(true);
  expect(feedHasTitle(rss, "Channel")).toBe(false);
});

test("hrefParamStartsWith decodes url_encode output (+ for space, %27, %26, %E2%80%99)", () => {
  const x = "https://twitter.com/intent/tweet?text=Don%27t+stop&url=https%3A%2F%2Fexample.com%2Fblog%2Fx%2F";
  expect(hrefParamStartsWith(x, "text", "Don't stop")).toBe(true);
  expect(hrefParamStartsWith(x, "text", "Dont stop")).toBe(false);
  const bsky = "https://bsky.app/intent/compose?text=Q%26A+time%20https%3A%2F%2Fexample.com%2F";
  expect(hrefParamStartsWith(bsky, "text", "Q&A time")).toBe(true);
  expect(hrefParamStartsWith("?text=%22hi%22+there", "text", '"hi" there')).toBe(true);
  expect(
    hrefParamStartsWith("?text=Anthropic%E2%80%99s+note", "text", "Anthropic\u2019s note"),
  ).toBe(true);
  expect(hrefParamStartsWith("?text=a%2Bb", "text", "a+b")).toBe(true);
  expect(hrefParamStartsWith("?text=Less+%3C+more", "text", "Less < more")).toBe(true);
});

test("hrefParamStartsWith tolerates a malformed escape and an empty needle", () => {
  expect(hrefParamStartsWith("?text=100%+sure", "text", "100% sure")).toBe(true);
  expect(hrefParamStartsWith("?text=x", "text", "")).toBe(false);
  expect(hrefParamStartsWith("?text=x", "missing", "x")).toBe(false);
});

// Regression: the share check once looked for the title's FIRST WORD anywhere
// in the href. A "Quoting ..." post has `quoting` in its slug, so the `url=`
// parameter alone satisfied it. Red on the old code (hrefCarries(href,
// "Quoting") was true for both hrefs below); the real share-row.html shapes.
test("hrefParamStartsWith is not satisfied by the title's words appearing in the slug", () => {
  const title = "Quoting Anthropic\u2019s \u201Csomewhat less robust\u201D";
  const url = encodeURIComponent(
    "https://adamdaniel.ai/blog/quoting-anthropics-somewhat-less-robust/",
  );
  const xNoTitle = `https://twitter.com/intent/tweet?text=&url=${url}`;
  const xOtherTitle = `https://twitter.com/intent/tweet?text=Unrelated+words&url=${url}`;
  const bskyNoTitle = `https://bsky.app/intent/compose?text=%20${url}`;
  for (const href of [xNoTitle, xOtherTitle, bskyNoTitle]) {
    expect(hrefParamStartsWith(href, "text", title), href).toBe(false);
  }
  // Only the first word of the title in text= is not the title either.
  expect(
    hrefParamStartsWith(`https://twitter.com/intent/tweet?text=Quoting&url=${url}`, "text", title),
  ).toBe(false);
  // The shapes share-row.html emits for the full title do pass.
  const enc = encodeURIComponent(title).replace(/%20/g, "+");
  expect(hrefParamStartsWith(`https://twitter.com/intent/tweet?text=${enc}&url=${url}`, "text", title)).toBe(true);
  expect(hrefParamStartsWith(`https://bsky.app/intent/compose?text=${enc}%20${url}`, "text", title)).toBe(true);
});

test("hrefParamStartsWith does not accept a longer word that merely begins with the title", () => {
  expect(hrefParamStartsWith("?text=Notes+on+shipping&url=x", "text", "Notes on")).toBe(true);
  expect(hrefParamStartsWith("?text=Notesy+stuff&url=x", "text", "Notes")).toBe(false);
});

test("visibleTitleLocator hands the raw title to getByText (no selector interpolation)", () => {
  for (const title of TITLES) {
    const calls = [];
    const located = { filter: (arg) => (calls.push(["filter", arg]), "LOCATOR") };
    const page = {
      getByText: (text, opts) => (calls.push(["getByText", text, opts]), located),
      locator: () => {
        throw new Error("title must not be interpolated into a CSS/text selector");
      },
    };
    expect(visibleTitleLocator(page, title)).toBe("LOCATOR");
    expect(calls).toEqual([
      ["getByText", title, { exact: true }],
      ["filter", { visible: true }],
    ]);
  }
});

// discoverTags reads each tag's name from the /tags/ index. The theme shows
// that name uppercase with CSS `text-transform` (#737), and `innerText`
// applies it, so reading it that way returned "WELCOME" for the stored
// "Welcome" and tags.spec.js failed comparing it to the tag page's heading.
// The fake locator behaves like a browser: innerText is transformed,
// textContent is the stored text.
test("discoverTags returns the stored tag name, not the CSS-uppercased one", async () => {
  const stored = [{ slug: "welcome", name: "Welcome", count: "3" }];
  const text = (value, transform) => ({
    innerText: async () => (transform ? value.toUpperCase() : value),
    textContent: async () => value,
  });
  const itemFor = (t) => ({
    locator: (sel) => {
      if (sel === "a.tag-list-link") return { getAttribute: async () => `/tags/${t.slug}/` };
      if (sel === ".tag-list-name") return text(t.name, true);
      if (sel === ".tag-list-count") return text(t.count, false);
      throw new Error(`unexpected selector ${sel}`);
    },
  });
  const page = {
    goto: async () => ({ status: () => 200 }),
    locator: () => ({ count: async () => stored.length, nth: (i) => itemFor(stored[i]) }),
  };
  expect(await discoverTags(page)).toEqual([{ slug: "welcome", name: "Welcome", count: 3 }]);
});

// #754: `quotes` and `Quotes` slugify alike and share /tags/quotes/, so the
// /tags/ index must show ONE card for them. duplicateTagSlugs is the check
// tags.spec.js runs on what discoverTags read from the live index.
test("duplicateTagSlugs flags two cards that share one /tags/<slug>/ (#754)", async () => {
  const card = (name, slug) => ({ name, slug, count: 1 });
  expect(duplicateTagSlugs([card("quotes", "quotes"), card("Quotes", "quotes"), card("RAG", "rag")])).toEqual([
    "quotes",
  ]);
  expect(duplicateTagSlugs([card("Quotes", "quotes"), card("RAG", "rag")])).toEqual([]);
  expect(duplicateTagSlugs([])).toEqual([]);
  // A slug is lowercase by construction, but the check must not depend on it.
  expect(duplicateTagSlugs([card("a", "Quotes"), card("b", "quotes")])).toEqual(["quotes"]);
});
