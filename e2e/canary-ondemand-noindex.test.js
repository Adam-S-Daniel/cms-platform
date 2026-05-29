// @lane: local — fs reads of locally-built canary pages + sitemap; no network
// Lock in the canary collection's "reachable but unadvertised" contract.
//
// `_e2e/canary-{post,page,project}.md` exist so the publish-loop tests have
// a stable target on every environment. Their public URLs must:
//   1. Render with `<meta name="robots" content="noindex,nofollow">` so
//      search engines never index the test fixtures.
//   2. Be excluded from `sitemap.xml` and `feed.xml` so the URLs aren't
//      advertised to crawlers via either mechanism.
//
// `_config.yml` already sets `sitemap: false` and `robots: noindex,nofollow`
// in the e2e collection defaults — this test pins those defaults so a
// future contributor who adds a new doc-type default can't silently leak
// the canaries.

const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const SITE_DIR = path.join(REPO_ROOT, "_site");
const CANARIES = ["canary-post", "canary-page", "canary-project"];

function readSite(p) {
  // The Playwright `webServer` builds Jekyll on test start; if a contributor
  // runs this test in isolation without that server, surface a clear hint
  // rather than a cryptic ENOENT.
  if (!fs.existsSync(p)) {
    throw new Error(
      `${path.relative(REPO_ROOT, p)} not found — run \`bundle exec jekyll build --quiet\` first, ` +
        "or let `npx playwright test` start the webServer.",
    );
  }
  return fs.readFileSync(p, "utf8");
}

test("each canary URL renders with robots: noindex,nofollow", () => {
  for (const slug of CANARIES) {
    const file = path.join(SITE_DIR, "e2e", slug, "index.html");
    const html = readSite(file);
    expect(html, `${slug}: missing or wrong robots meta`).toMatch(
      /<meta\s+name=["']robots["']\s+content=["']noindex\s*,\s*nofollow["']/i,
    );
  }
});

test("sitemap.xml does not advertise any canary URL", () => {
  const xml = readSite(path.join(SITE_DIR, "sitemap.xml"));
  for (const slug of CANARIES) {
    expect(xml, `sitemap.xml leaks ${slug}`).not.toContain(`/e2e/${slug}/`);
  }
});

test("feed.xml does not advertise any canary URL", () => {
  const xml = readSite(path.join(SITE_DIR, "feed.xml"));
  for (const slug of CANARIES) {
    expect(xml, `feed.xml leaks ${slug}`).not.toContain(`/e2e/${slug}/`);
  }
});
