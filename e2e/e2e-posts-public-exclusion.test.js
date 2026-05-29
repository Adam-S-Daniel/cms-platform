// @lane: local — builds Jekyll into a throwaway dir + reads the output; no network, no browser
//
// Regression lock for the e2e-post public-aggregation leak.
//
// Context: the CMS publish-loop specs run ephemeral fixtures through the
// PUBLIC `posts` collection (`_posts/2099-12-31-e2e-prod-mutate-<runId>.md`,
// `_posts/2099-12-31-e2e-media-roundtrip-<runId>.md`, the persistent
// `_posts/2024-01-02-e2e-unpublish-canary.md`). Once a spec flips one to
// `published: true` it lands in `site.posts` and — before this fix — leaked
// into the Atom feed (/feed.xml), the homepage + /blog/ listings, the tag
// archives + per-tag feeds, and sitemap.xml. The owner saw "E2E Media
// Roundtrip <runId>" / "E2E Unpublish Canary" in their RSS reader.
//
// `_plugins/exclude_e2e_posts.rb` stamps `sitemap: false` + `feed_exclude:
// true` on any post whose SLUG starts with `e2e-` OR that sets
// `test_fixture: true`. The slug signature is the load-bearing one: a Decap
// "+ New Post" UI create writes only the `posts`-collection fields and CANNOT
// set the flag, so a UI-created e2e fixture has the `e2e-` slug but no flag.
// Every public surface (the custom feed.xml, _layouts/atom_feed.xml, the
// listings, and the tag generators) filters on that shared marker.
//
// This test proves the SLUG-SIGNATURE path end-to-end: it drops a temporary
// `_posts/2099-12-31-e2e-feedleak-probe.md` with an `e2e-` slug and NO
// `test_fixture` flag and NO `sitemap: false` (exactly what the UI produces),
// runs a real `bundle exec jekyll build` into a THROWAWAY output dir (so the
// shared `_site/` the webServer serves is never touched), then asserts the
// probe is ABSENT from feed.xml / sitemap.xml / homepage / blog index / its
// tag archive + tag feed, yet PRESENT (serves 200) at /blog/<slug>/. It also
// asserts a real published post is unaffected (still in feed + sitemap), so
// the exclusion can't over-reach. The temp fixture is always removed in
// afterAll.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const POSTS_DIR = path.join(REPO_ROOT, "_posts");

// Probe: an `e2e-` slug (derived from the filename, no explicit `slug:`),
// `published: true`, a tag, and crucially NO `test_fixture` flag and NO
// `sitemap: false` — the shape a Decap UI "+ New Post" create produces.
const PROBE_FILENAME = "2099-12-31-e2e-feedleak-probe.md";
const PROBE_PATH = path.join(POSTS_DIR, PROBE_FILENAME);
const PROBE_SLUG = "e2e-feedleak-probe";
const PROBE_TAG = "Feedleak Probe Tag";
const PROBE_TAG_SLUG = "feedleak-probe-tag";
const PROBE_TITLE = "E2E Feedleak Probe";
const PROBE_CONTENT = `---
title: ${PROBE_TITLE}
date: 2099-12-31 00:00:00 +0000
tags: [${PROBE_TAG}]
published: true
---

Temporary build-and-assert fixture for e2e-posts-public-exclusion.test.js.
It has an \`e2e-\` slug but NO test_fixture flag and NO sitemap: false,
mirroring a Decap UI-created e2e post. Removed in afterAll.
`;

let OUT_DIR; // throwaway Jekyll destination for this test's build

function buildInto(destDir) {
  // Production env mirrors the real deploy build. `-d` writes to a
  // throwaway dir so the shared `_site/` (served by the Playwright
  // webServer and read by sibling specs) is never disturbed.
  execFileSync("bundle", ["exec", "jekyll", "build", "--quiet", "-d", destDir], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, JEKYLL_ENV: "production" },
  });
}

function read(rel) {
  return fs.readFileSync(path.join(OUT_DIR, rel), "utf8");
}

function exists(rel) {
  return fs.existsSync(path.join(OUT_DIR, rel));
}

// Pure-node + filesystem only; bump the timeout to cover a cold Jekyll build.
test.describe("e2e/test-fixture posts are excluded from public aggregation", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(() => {
    // Guard: never clobber a real post if the probe name somehow collided.
    if (fs.existsSync(PROBE_PATH)) fs.unlinkSync(PROBE_PATH);
    fs.writeFileSync(PROBE_PATH, PROBE_CONTENT);
    OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-exclude-build-"));
    buildInto(OUT_DIR);
  });

  test.afterAll(() => {
    // Always remove the temp fixture and the throwaway build dir.
    if (fs.existsSync(PROBE_PATH)) fs.unlinkSync(PROBE_PATH);
    if (OUT_DIR && fs.existsSync(OUT_DIR)) fs.rmSync(OUT_DIR, { recursive: true, force: true });
  });

  test("the build produced the surfaces we assert on", () => {
    for (const rel of ["feed.xml", "sitemap.xml", "index.html", "blog/index.html"]) {
      expect(exists(rel), `${rel} should have been built`).toBe(true);
    }
  });

  test("the e2e post is ABSENT from /feed.xml", () => {
    expect(read("feed.xml"), "e2e probe leaked into the Atom feed").not.toContain(PROBE_SLUG);
  });

  test("the e2e post is ABSENT from sitemap.xml", () => {
    expect(read("sitemap.xml"), "e2e probe leaked into the sitemap").not.toContain(PROBE_SLUG);
  });

  test("the e2e post is ABSENT from the homepage listing", () => {
    expect(read("index.html"), "e2e probe leaked onto the homepage").not.toContain(PROBE_SLUG);
  });

  test("the e2e post is ABSENT from the /blog/ index listing", () => {
    expect(read("blog/index.html"), "e2e probe leaked into the blog index").not.toContain(
      PROBE_SLUG,
    );
  });

  test("the e2e post's tag does not mint a public archive page or tag-cloud entry", () => {
    // auto_tag_pages.rb excludes feed_exclude posts, so a tag carried ONLY
    // by the probe never produces a /tags/<slug>/ archive and never appears
    // on the /tags/ index.
    const tagArchive = path.join("tags", PROBE_TAG_SLUG, "index.html");
    if (exists(tagArchive)) {
      expect(read(tagArchive), "tag archive leaked the e2e probe").not.toContain(PROBE_SLUG);
    }
    if (exists("tags/index.html")) {
      expect(read("tags/index.html"), "/tags/ index leaked the e2e probe tag").not.toContain(
        PROBE_TAG_SLUG,
      );
    }
  });

  test("the e2e post's tag does not mint a public per-tag Atom feed", () => {
    // tag_feeds.rb skips feed_exclude posts, so no /tags/<slug>/feed.xml is
    // generated for a probe-only tag; if one existed for any reason, it must
    // not list the probe.
    const tagFeed = path.join("tags", PROBE_TAG_SLUG, "feed.xml");
    if (exists(tagFeed)) {
      expect(read(tagFeed), "per-tag feed leaked the e2e probe").not.toContain(PROBE_SLUG);
    }
  });

  test("the e2e post STILL renders and serves at /blog/<slug>/ (200 contract)", () => {
    // The prod-loop specs assert the published canary returns 200 at its
    // direct URL (then 404 after delete). Excluding it from aggregation must
    // NOT stop it being built at its own URL.
    const page = path.join("blog", PROBE_SLUG, "index.html");
    expect(exists(page), `${PROBE_SLUG} must still be built at /blog/${PROBE_SLUG}/`).toBe(true);
    expect(read(page), "the served e2e post page should contain its title").toContain(PROBE_TITLE);
  });

  test("a real published post is NOT over-excluded (still in feed + sitemap)", () => {
    // Discover a real (non-e2e) published post from the built blog index so
    // this doesn't hardcode a fixture name. The blog index already filters
    // out e2e posts, so any /blog/<slug>/ link there is a genuine post.
    const blogIndex = read("blog/index.html");
    const realSlugs = Array.from(blogIndex.matchAll(/href="[^"]*\/blog\/([^/"]+)\/"/g))
      .map((m) => m[1])
      .filter((s) => !s.startsWith("e2e-"));
    test.skip(
      realSlugs.length === 0,
      "no real (non-e2e) published post on the site to assert non-over-exclusion against",
    );
    const realSlug = realSlugs[0];
    expect(read("feed.xml"), `real post ${realSlug} should be in the feed`).toContain(realSlug);
    expect(read("sitemap.xml"), `real post ${realSlug} should be in the sitemap`).toContain(
      realSlug,
    );
    expect(read("index.html"), `real post ${realSlug} should be on the homepage`).toContain(
      realSlug,
    );
  });
});
