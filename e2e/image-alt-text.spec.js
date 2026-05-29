// @lane: local — walks _site/sitemap.xml from the local Jekyll build; @parity-eligible
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, TARGET } = require("./base");
const { isTestFixturePost } = require("./public-content");

// Plan unit B2 — Image alt-text audit (`@parity`).
//
// Every `<img>` rendered on the public site must be reachable to assistive
// tech: either it carries a non-empty `alt` (announced as text), or it is
// explicitly marked decorative via `role="presentation"` or
// `aria-hidden="true"`. The audit walks the built `_site/sitemap.xml` so
// new content is covered automatically — adding a post that ships a bare
// `<img src="…">` regresses this spec without any test edit.
//
// Why this is load-bearing: prior coverage stopped at static-config
// invariants (cms-config.spec.js) and a handful of hand-picked URLs
// (blog-post.spec.js, tags.spec.js, etc.). A featured image, gallery
// thumbnail, or markdown `![](…)` with an empty alt slipped through
// silently. This spec closes that gap by deriving the URL list from the
// same sitemap a search crawler would consume.
//
// `@parity` tag: paired with the future G3 `TARGET=` switch so the same
// audit can run against local `_site/`, preview-pr*, and prod. Until G3
// ships, this spec runs against `localhost:4000` only — exactly the same
// surface the rest of the suite exercises today.
//
// Project gating: chromium-desktop-1080 only. The audit is a static-content
// contract — running it across the full browser/viewport matrix would
// multiply runtime by ~8× without finding additional bugs (the same DOM
// is served regardless of viewport).

const REPO_ROOT = path.join(__dirname, "..");
const SITEMAP_PATH = path.join(REPO_ROOT, "_site", "sitemap.xml");

// Documented exceptions. Any URL added here must be paired with a comment
// explaining why the alt-text contract doesn't apply (e.g. a third-party
// embed whose markup we don't control). Empty by default — keep it that
// way unless there's a real reason.
const URL_ALLOWLIST = new Set([
  // (none)
]);

function readSitemap() {
  // The Playwright `webServer` block in `playwright.config.js` runs
  // `bundle exec jekyll build --quiet` before the suite starts, so this
  // file is guaranteed to exist when tests execute via `npx playwright
  // test`. If a contributor invokes the spec without the webServer (e.g.
  // running `node` against the file directly), surface a clear hint.
  if (!fs.existsSync(SITEMAP_PATH)) {
    throw new Error(
      `${path.relative(REPO_ROOT, SITEMAP_PATH)} not found — run ` +
        "`bundle exec jekyll build --quiet` first, or let " +
        "`npx playwright test` start the webServer.",
    );
  }
  return fs.readFileSync(SITEMAP_PATH, "utf8");
}

function parseSitemapUrls(xml) {
  // jekyll-sitemap emits a flat <urlset><url><loc>…</loc></url> shape.
  // No nested namespaces, no CDATA in the loc element — a regex pull is
  // sufficient and avoids adding an XML parser dependency.
  const urls = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

function toLocalPath(absoluteUrl) {
  // Sitemap entries are absolute (https://adamdaniel.ai/...). Convert to
  // a root-relative path so we can hit them against `baseURL`
  // (http://localhost:4000) without depending on prod DNS.
  try {
    const u = new URL(absoluteUrl);
    return u.pathname + u.search;
  } catch {
    // Already a relative URL.
    return absoluteUrl;
  }
}

// Dev-only admin shells. jekyll-sitemap picks them up from `_site/` but
// deploy-{production,preview}.yml drop them from the S3 sync (`--exclude`,
// see those workflows). On TARGET=preview / prod these URLs 404 — that's
// a sitemap-vs-deploy discrepancy, not an alt-text problem, so skip them
// here. Audited on `local` where they DO render.
const ADMIN_DEV_SHELLS = new Set(["/admin/index-local.html", "/admin/index-test.html"]);

// Derive the post URL slug from a `/blog/<slug>/` path so the shared
// test-fixture predicate can match the structural `e2e-` canary signature.
// Returns null for non-/blog/ paths (homepage, tags, etc.).
function blogSlugFromPath(urlPath) {
  const m = urlPath.match(/^\/blog\/([^/]+)\/?$/);
  return m ? m[1] : null;
}

function shouldSkip(urlPath, target) {
  // `/preview/` is the in-CMS WYSIWYG preview shell — its `<img>` content
  // is injected at runtime via postMessage, so a static crawl audits an
  // empty layout. Covered separately by preview-bridge.spec.js.
  if (urlPath.startsWith("/preview/")) return true;
  if (URL_ALLOWLIST.has(urlPath)) return true;
  if (target !== "local" && ADMIN_DEV_SHELLS.has(urlPath)) return true;
  // Skip E2E test-fixture canaries. The ephemeral prod-loop posts
  // (`/blog/e2e-{prod-mutate,media-roundtrip}-<runId>/`) are born
  // `published: true` through the Decap UI and briefly appear in the
  // sitemap mid-run (the posts collection has no `sitemap:`/`robots:`
  // widget, so the UI can't mark them noindex). They are noindex test
  // fixtures, not public content — and a transient orphan one of them
  // leaves on `main` must not red this REQUIRED @parity check on an
  // unrelated PR (#1771 Cat-2 fix). Keyed on the shared `e2e-` slug
  // signature via the single source of truth in public-content.js.
  const slug = blogSlugFromPath(urlPath);
  if (slug && isTestFixturePost(null, { urlSlug: slug })) return true;
  return false;
}

test.describe(
  "@parity image alt-text audit",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-1080-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.beforeEach(() => {
      // Self-skip when there's no local Jekyll build (TARGET=preview/prod):
      // this audit walks the locally-built _site/sitemap.xml; it runs fully
      // in the local lane and skips elsewhere instead of ENOENT-failing.
      test.skip(
        !fs.existsSync(SITEMAP_PATH),
        "_site/sitemap.xml not built (non-local target) — local-build image-alt audit",
      );
    });

    test("every <img> on every sitemap URL has alt, role=presentation, or aria-hidden", async ({
      page,
    }) => {
      const xml = readSitemap();
      const allUrls = parseSitemapUrls(xml).map(toLocalPath);
      expect(allUrls.length, "sitemap.xml should advertise at least one URL").toBeGreaterThan(0);

      const urls = allUrls.filter((u) => !shouldSkip(u, TARGET));

      // Accumulate every violation across every page rather than failing
      // on the first one — gives the editor a complete picture in CI logs
      // when a content sweep drops alts in multiple places at once.
      const allViolations = [];

      for (const url of urls) {
        const response = await page.goto(url, { waitUntil: "networkidle" });
        // Sitemap should not advertise broken URLs; surface 404s here as
        // their own failure shape so they don't masquerade as alt-text
        // violations.
        expect(
          response && response.status(),
          `expected 200 from ${url}, got ${response && response.status()}`,
        ).toBe(200);

        const violations = await page.$$eval("img", (imgs) =>
          imgs
            .filter(
              (img) =>
                !img.alt &&
                img.getAttribute("role") !== "presentation" &&
                img.getAttribute("aria-hidden") !== "true",
            )
            .map((img) => ({
              src: img.src,
              parent: img.parentElement && img.parentElement.tagName,
            })),
        );

        for (const v of violations) {
          allViolations.push({ url, ...v });
        }
      }

      expect(
        allViolations,
        'Every <img> must have a non-empty alt, role="presentation", or ' +
          'aria-hidden="true". Violations:\n' +
          allViolations
            .map((v) => `  - ${v.url}: <img src="${v.src}"> (parent: ${v.parent || "?"})`)
            .join("\n"),
      ).toEqual([]);
    });
  },
);
