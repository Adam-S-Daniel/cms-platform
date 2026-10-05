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

// ── Title comparison helpers ────────────────────────────────────────────────
// `discoverPost().title` is the anchor's rendered text (`innerText`: entities
// decoded, quotes exactly as authored). The same title reaches other surfaces
// in a different spelling, so a spec must not compare it raw:
//
//   - feed.xml      jekyll-feed renders `smartify | strip_html |
//                   normalize_whitespace | xml_escape` into a `type="html"`
//                   <title>: `"` and `'` become curly quotes, `--` and `...`
//                   become dashes and an ellipsis, and `&` / `<` come out
//                   entity-escaped TWICE (smartify's HTML escape, then
//                   xml_escape), e.g. `A &amp;amp; B`.
//   - share intents the X / Bluesky hrefs carry `url_encode`d text (`+` for a
//                   space, `%27`, `%26`, `%E2%80%99`).
//   - a selector    a `"` in `:text-is("…")` is a parse error and a `\` a
//                   silent miss; Playwright's own `getByText` takes the raw
//                   string.

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// One pass of XML/HTML entity decoding (the core named entities plus
// numeric). A single pass over the string, so `&amp;lt;` becomes `&lt;`, not
// `<`.
function decodeEntities(s) {
  return String(s).replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g,
    (whole, dec, hex, name) => {
      if (name) return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : whole;
      const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
    },
  );
}

// Fold the typography Jekyll's `smartify` applies so a title and its
// smartified feed spelling compare equal: the straight sequences become the
// typographic characters, then curly quotes fold to straight ones. Applied to
// BOTH sides, so the result does not depend on which side was smartified.
// Also trims and collapses whitespace (the feed runs `normalize_whitespace`).
function normalizeTitle(s) {
  return String(s)
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/\.\.\./g, "…")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Does an Atom/RSS document carry `title` in some <title> element? Compares
// decoded text, so it holds for `&`, `<`, quotes and smartified spellings.
function feedHasTitle(xml, title) {
  const want = normalizeTitle(title);
  if (!want) return false;
  const re = /<title\b([^>]*)>([\s\S]*?)<\/title>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[2].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
    let text = decodeEntities(inner);
    // `type="html"` content is itself HTML: a second decode yields the text.
    if (/\btype\s*=\s*["']html["']/i.test(m[1])) text = decodeEntities(text);
    if (normalizeTitle(text).includes(want)) return true;
  }
  return false;
}

// Does a share-intent href carry `text` (case-insensitive, any `url_encode`
// spelling)? `+` is a space in form encoding, so it is decoded BEFORE the
// percent escapes (a literal plus arrives as %2B).
function hrefCarries(href, text) {
  const want = normalizeTitle(text).toLowerCase();
  if (!want) return false;
  let decoded = String(href).replace(/\+/g, " ");
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Malformed escape: compare the form-decoded string as-is.
  }
  return normalizeTitle(decoded).toLowerCase().includes(want);
}

// Every VISIBLE element whose whole text is `title`. Playwright-native
// (`getByText` takes the raw string, so `"`, `\` and `&` need no escaping —
// the former `:text-is("${title}")` selector broke on them) and the text
// engine already skips <head>, so <title> and <meta> need no `:not()`.
function visibleTitleLocator(page, title) {
  return page.getByText(title, { exact: true }).filter({ visible: true });
}

module.exports = {
  discoverTags,
  discoverPost,
  pickPostLink,
  decodeEntities,
  normalizeTitle,
  feedHasTitle,
  hrefCarries,
  visibleTitleLocator,
};
