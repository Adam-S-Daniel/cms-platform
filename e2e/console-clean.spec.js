// @lane: local — fs reads of _site/sitemap + local pageviews; @parity-eligible via TARGET=
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { slugify, parseFrontMatter, isPublished, isTestFixturePost } = require("./public-content");
const cap = require("./site-capabilities");

// B4. Console-clean content pages — @parity
// ─────────────────────────────────────────────────────────────────────────────
// Navigates every published PUBLIC-CONTENT URL on the site and fails if any
// page emits a `console.error` or unhandled `pageerror`. The tag `@parity`
// marks this as a check that should give the same answer in non-prod and prod
// — content rendering is environment-agnostic, so a regression here means the
// same failure in both.
//
// URL list is built at load time from the source repo (not the rendered site)
// so a missing route surfaces as a 404/console.error inside the test:
//   _posts/<file>.md          → /blog/<derived-slug>/
//   _tags/<slug>.md           → /tags/<slug>/
//   _projects/                → skipped (collections.projects.output: false in
//                               _config.yml; no per-project pages exist)
//   pages/<file>.md (published: true) → front-matter permalink
//   static                    → /, /blog/, /tags/  (homepage + listings)
// `/projects/` (the listing index) is `published: false` in `projects/index.html`,
// so it's intentionally absent from the static set; if/when it's restored, the
// loader below will pick it up via a future `pages/` entry or an explicit add.
//
// `/admin/` is skipped — it's the CMS surface, not site content, and Decap
// emits its own log noise we don't want to gate site PRs on.
//
// `_e2e/` canaries are skipped — `noindex,nofollow` system content driven by
// the publish-loop tests; not advertised to readers.
//
// E2E TEST-FIXTURE canaries in `_posts/` are skipped via the shared
// `isTestFixturePost` predicate (e2e/public-content.js). This is the #1771
// Cat-2 fix: the ephemeral prod-loop posts
// (`_posts/2099-12-31-e2e-{prod-mutate,media-roundtrip}-<runId>.md`) are
// born `published: true` through the Decap UI and briefly serve mid-run.
// They are noindex test fixtures (validated by the loop specs themselves),
// NOT public content — and a transient 404 of a deleted-but-not-swept
// orphan's resource must not red-fail this REQUIRED check (which would
// poison every cms PR, including the loop's own create PR). The predicate
// keys on the structural `e2e-` slug signature because the UI-created
// posts carry neither `test_fixture: true` nor `sitemap: false` (the
// posts collection has no widget for them).

// SITE_ROOT-aware (consistent with the other content-crawl specs): in a
// consumer the harness sits at the site root so `__dirname/..` IS the site;
// SITE_ROOT is the explicit, portable form. They agree in self-CI.
const REPO_ROOT = process.env.SITE_ROOT || path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const TAGS_DIR = path.join(REPO_ROOT, "_tags");
const PAGES_DIR = path.join(REPO_ROOT, "pages");

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function buildContentUrls() {
  const urls = new Set();

  // Static pages every reader can hit from the homepage nav.
  // /projects/ is excluded on purpose: pages/../projects/index.html has
  // `published: false`. If it's flipped on later, this list should grow.
  //
  // #33 — `/blog/` and `/tags/` only exist when the consumer keeps the posts /
  // tags base collections (a single-page opt-out via cms.base_collections
  // renders neither, so asserting a 200 there would red-fail). The homepage
  // `/` is always present. Keyed on the SOURCE `_config.yml` base_collections
  // (build-independent) so it's correct in the preview/prod @parity lanes too.
  // The full fixture-site + adamdaniel.ai keep both → both are crawled there.
  urls.add("/");
  if (cap.keepsBaseCollection(REPO_ROOT, "posts")) urls.add("/blog/");
  if (cap.keepsBaseCollection(REPO_ROOT, "tags")) urls.add("/tags/");

  // _posts/ — derive /blog/<slug>/ via the same rule cms-preview-url.spec.js
  // uses (explicit `slug:` wins; otherwise slugify the title). Mirror
  // Jekyll's default-published semantics: include unless the front matter
  // explicitly says `published: false`. A post that's been pulled stops
  // being asserted on; one that omits the key entirely (Jekyll publishes
  // it) is still covered.
  //
  // ALSO skip E2E test-fixture canaries via the shared isTestFixturePost
  // predicate (e2e/public-content.js). It excludes posts flagged
  // `test_fixture: true` OR `sitemap: false` (the persistent `_e2e`/unpublish
  // canaries) AND posts whose slug/filename carries the `e2e-` canary
  // signature (the ephemeral prod-loop posts created through the Decap UI,
  // which carry NEITHER flag because the posts collection has no widget for
  // them — #1771 Cat-2 fix). These are noindex test fixtures validated by
  // the loop specs themselves; a transient orphan's 404'd resource must not
  // red this REQUIRED public-content check.
  for (const file of listMd(POSTS_DIR)) {
    const fm = parseFrontMatter(path.join(POSTS_DIR, file));
    if (!fm) continue;
    if (!isPublished(fm)) continue;
    if (isTestFixturePost(fm, { filename: file })) continue;
    const slugSource = fm.slug && fm.slug !== "" ? fm.slug : fm.title;
    if (!slugSource) continue;
    urls.add(`/blog/${slugify(slugSource)}/`);
  }

  // _tags/<slug>.md — Jekyll's `permalink: /tags/:slug/` maps to the filename.
  for (const file of listMd(TAGS_DIR)) {
    const slug = file.replace(/\.md$/, "");
    urls.add(`/tags/${slug}/`);
  }

  // pages/*.md — same Jekyll default-published rule. Both contributor
  // pages (`about.md`, `contact.md`) currently ship with `published: false`
  // so this block is a no-op until one is restored. Skip if no permalink
  // (Jekyll's default would be unstable to predict here).
  for (const file of listMd(PAGES_DIR)) {
    const fm = parseFrontMatter(path.join(PAGES_DIR, file));
    if (!fm) continue;
    if (!isPublished(fm)) continue;
    if (!fm.permalink) continue;
    urls.add(fm.permalink);
  }

  return Array.from(urls).sort();
}

// Errors that are expected on the local dev server / preview but never on
// production proper, or that are noise from environment-specific assets.
// Anything matched here is filtered out *before* the assertion.
function isAllowlisted(text) {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Browsers emit a 404 for /favicon.ico when no favicon is shipped at the
  // exact root path. The site uses a custom icon path in the head, so the
  // implicit /favicon.ico request is harmless.
  if (lower.includes("/favicon.ico")) return true;

  // CloudWatch RUM is production-only (gated by JEKYLL_ENV=production AND a
  // non-empty app_monitor_id). On preview/local the snippet isn't emitted at
  // all — but if a future config wires it up before the local stack is ready,
  // CORS / Failed to fetch errors against the AWS endpoints are not a content
  // regression. Allowlist by hostname fragments.
  if (lower.includes("cognito")) return true;
  if (lower.includes("cloudwatch-rum")) return true;
  if (lower.includes("rum.us-east-1.amazonaws.com")) return true;

  return false;
}

const CONTENT_URLS = buildContentUrls();

test.describe(
  "Console-clean content pages @parity",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.beforeEach(() => {});

    for (const url of CONTENT_URLS) {
      test(`@parity no console.error or pageerror on ${url}`, async ({ page }) => {
        const consoleErrors = [];
        const pageErrors = [];

        // Listeners must be attached BEFORE goto so we don't miss errors that
        // fire during the initial parse/script-execute pass.
        page.on("console", (msg) => {
          if (msg.type() === "error") consoleErrors.push(msg.text());
        });
        page.on("pageerror", (err) => {
          pageErrors.push(`${err.name}: ${err.message}`);
        });

        const response = await page.goto(url, { waitUntil: "networkidle" });
        expect(response, `goto(${url}) returned no response`).not.toBeNull();
        expect(response.status(), `${url} should be 200`).toBe(200);

        const filteredConsole = consoleErrors.filter((t) => !isAllowlisted(t));
        const filteredPage = pageErrors.filter((t) => !isAllowlisted(t));
        const all = [
          ...filteredConsole.map((t) => `console.error: ${t}`),
          ...filteredPage.map((t) => `pageerror: ${t}`),
        ];

        expect(all, `Unexpected JS errors on ${url}:\n  ${all.join("\n  ")}`).toEqual([]);
      });
    }
  },
);
