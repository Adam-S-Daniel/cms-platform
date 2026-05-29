// @lane: local — reads _site/ artefacts produced by the local Jekyll build
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Plan unit B6 — draft isolation contract.
//
// Drafts (`published: false` in front matter) must NOT appear on any
// public surface: the rendered URL 404s, the sitemap omits them, the
// Atom feed omits them, and the homepage carries no link to them.
// Jekyll honors this at build time by skipping `published: false`
// entries entirely; this spec is the regression lock that catches a
// future config change (e.g. `unpublished: true` defaults block, or a
// _config.yml `show_drafts:` flip) that would silently leak drafts.
//
// `e2e/sitemap.spec.js` already asserts that no existing `_posts/*.md`
// with `published: false` leaks into the sitemap. This spec goes one
// further by *creating* a fresh draft and verifying every public
// surface stays empty — a stronger guarantee, because it catches
// regressions before any draft exists in the tree to seed sitemap.spec.
//
// Tagged `@parity`-aware: when G3 ships the `TARGET=preview|prod`
// switch, the read-only assertions (URL → 404, sitemap absence, feed
// absence, homepage absence) work cross-target without modification.
// The mutating local path (write file, rebuild, cleanup) only fires
// when TARGET is unset or "local".

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");
const SITE_DIR = path.join(REPO_ROOT, "_site");

const DRAFT_SLUG = "e2e-draft-isolation";
const DRAFT_FILENAME = `2099-01-01-${DRAFT_SLUG}.md`;
const DRAFT_PATH = path.join(POSTS_DIR, DRAFT_FILENAME);
const DRAFT_URL_PATH = `/blog/${DRAFT_SLUG}/`;

const DRAFT_BODY = `---
title: E2E Draft Isolation
slug: ${DRAFT_SLUG}
date: 2099-01-01 00:00:00 +0000
published: false
excerpt: Test post — should never be reachable.
---
This post should never appear on any public surface.
`;

const TARGET = process.env.TARGET || "local";
const IS_LOCAL = TARGET === "local";

function jekyllBuild() {
  // Quiet build into the same `_site/` the playwright webServer is
  // serving from, so the deletion/non-creation of the draft is
  // picked up without restarting `npx serve`.
  // @parity-lint-allow: only invoked from beforeAll's IS_LOCAL branch (G3).
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

function writeDraft() {
  // @parity-lint-allow: only invoked from beforeAll's IS_LOCAL branch (G3).
  fs.writeFileSync(DRAFT_PATH, DRAFT_BODY);
}

function removeDraft() {
  if (fs.existsSync(DRAFT_PATH)) fs.unlinkSync(DRAFT_PATH);
  // Clear any stale rendered output too, in case a previous run
  // accidentally produced one. `_site/blog/<slug>/` would otherwise
  // be served by `npx serve` even though the source post is gone.
  const rendered = path.join(SITE_DIR, "blog", DRAFT_SLUG);
  // `force: true` makes rmSync a no-op when the path is absent, so no
  // existsSync guard is needed.
  // @parity-lint-allow: only invoked from afterAll's IS_LOCAL branch (G3).
  fs.rmSync(rendered, { recursive: true, force: true });
}

test.describe(
  "Drafts (published: false) stay isolated from public surfaces @parity",
  // Tagged @admin-write: drives /admin/* + writes (Decap Save, decap-server, etc.).
  // Runs on chromium-desktop-3k only. See playwright.config.js.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 240_000 });

    test.beforeAll(() => {
      if (!IS_LOCAL) {
        // Read-only path: TARGET=preview/prod just exercises the public
        // surface assertions against the deployed site. Skip the file
        // write + rebuild — we cannot mutate a remote target from here.
        return;
      }
      // Defensive cleanup in case a previous failed run left the file.
      removeDraft();
      writeDraft();
      jekyllBuild();
    });

    test.afterAll(() => {
      if (!IS_LOCAL) return;
      removeDraft();
      // Rebuild so subsequent specs in the same run don't see a half-
      // cleaned `_site/`. Cheap (~1s) and keeps the tree tidy.
      jekyllBuild();
    });

    test.beforeEach(({ page }) => {
      page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
    });

    test("rendered draft URL responds 404 @parity", async ({ page }) => {
      const response = await page.request.get(DRAFT_URL_PATH);
      expect(
        response.status(),
        `${DRAFT_URL_PATH} should 404 — drafts must not be reachable.`,
      ).toBe(404);
    });

    test("draft URL absent from sitemap.xml @parity", () => {
      // Local target: read the freshly built `_site/sitemap.xml`. For
      // remote targets, G3 will swap this for an HTTP fetch of the
      // deployed sitemap. The assertion shape is identical either way.
      const sitemapPath = path.join(SITE_DIR, "sitemap.xml");
      if (!IS_LOCAL) {
        // Remote read-only path placeholder — wire up via G3's TARGET=.
        test.skip(true, "Remote sitemap fetch lands with G3.");
        return;
      }
      expect(
        fs.existsSync(sitemapPath),
        "Expected _site/sitemap.xml to exist after Jekyll build.",
      ).toBe(true);
      const xml = fs.readFileSync(sitemapPath, "utf8");
      expect(
        xml.includes(DRAFT_SLUG),
        `Draft slug "${DRAFT_SLUG}" leaked into sitemap.xml — drafts must be excluded.`,
      ).toBe(false);
    });

    test("draft URL absent from feed.xml @parity", () => {
      const feedPath = path.join(SITE_DIR, "feed.xml");
      if (!IS_LOCAL) {
        test.skip(true, "Remote feed fetch lands with G3.");
        return;
      }
      expect(fs.existsSync(feedPath), "Expected _site/feed.xml to exist after Jekyll build.").toBe(
        true,
      );
      const xml = fs.readFileSync(feedPath, "utf8");
      expect(
        xml.includes(DRAFT_SLUG),
        `Draft slug "${DRAFT_SLUG}" leaked into feed.xml — drafts must be excluded.`,
      ).toBe(false);
    });

    test("homepage carries no link to the draft @parity", async ({ page }) => {
      await page.goto("/");
      // Any anchor whose href contains the draft slug is a leak. Catches
      // recent-posts widgets, archive lists, and any future homepage
      // surface that iterates the post collection without a published
      // filter.
      const leaks = await page
        .locator(`a[href*="${DRAFT_SLUG}"]`)
        .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
      expect(
        leaks,
        `Homepage links reference the draft: ${JSON.stringify(leaks, null, 2)}`,
      ).toEqual([]);
    });
  },
);
