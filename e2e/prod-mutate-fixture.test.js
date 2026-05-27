// @lane: local — pure builders for the ephemeral prod-loop posts (#1771 step 4)
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { readPublishedFlag, splitFrontMatter } = require("./fixture-baseline");
const {
  EPHEMERAL_DATE,
  PROD_MUTATE_SLUG_PREFIX,
  MEDIA_ROUNDTRIP_SLUG_PREFIX,
  buildProdMutatePost,
  buildMediaRoundtripPost,
  composePost,
} = require("./prod-mutate-fixture");

const REPO_ROOT = path.resolve(__dirname, "..");

test.describe("ephemeral prod-loop post builders (#1771 step 4)", () => {
  test("buildProdMutatePost is a pure function of runId (unique path/slug/url)", () => {
    const a = buildProdMutatePost({ runId: 1779999999999 });
    expect(a.slug).toBe(`${PROD_MUTATE_SLUG_PREFIX}-1779999999999`);
    expect(a.filePath).toBe(`_posts/${EPHEMERAL_DATE}-${PROD_MUTATE_SLUG_PREFIX}-1779999999999.md`);
    expect(a.publicPath).toBe(`/blog/${PROD_MUTATE_SLUG_PREFIX}-1779999999999/`);
    expect(a.title).toBe("E2E Prod Mutate 1779999999999");
    expect(a.marker).toBe(`${PROD_MUTATE_SLUG_PREFIX}:1779999999999`);

    // Distinct runIds never collide on a path (no shared mutable cell).
    const b = buildProdMutatePost({ runId: 1779999999998 });
    expect(b.filePath).not.toBe(a.filePath);
  });

  test("buildMediaRoundtripPost mirrors the shape with its own prefix", () => {
    const m = buildMediaRoundtripPost({ runId: 42 });
    expect(m.slug).toBe(`${MEDIA_ROUNDTRIP_SLUG_PREFIX}-42`);
    expect(m.filePath).toBe(`_posts/${EPHEMERAL_DATE}-${MEDIA_ROUNDTRIP_SLUG_PREFIX}-42.md`);
    expect(m.publicPath).toBe(`/blog/${MEDIA_ROUNDTRIP_SLUG_PREFIX}-42/`);
    expect(m.marker).toBe(`${MEDIA_ROUNDTRIP_SLUG_PREFIX}:42`);
  });

  test("the post is BORN published, noindex, sitemap:false, test_fixture", () => {
    for (const built of [
      buildProdMutatePost({ runId: 7 }),
      buildMediaRoundtripPost({ runId: 7 }),
    ]) {
      const { fileText } = built;
      // Born published — the loop CREATES a live post (it never toggles a
      // persistent file). #1771 step 4 inverts the resting state to 404.
      expect(readPublishedFlag(fileText)).toBe(true);
      expect(fileText).toMatch(/^robots: noindex,nofollow$/m);
      expect(fileText).toMatch(/^sitemap: false$/m);
      expect(fileText).toMatch(/^test_fixture: true$/m);
      expect(fileText).toMatch(/^date: 2099-12-31 /m);
    }
  });

  test("the runId marker is in BOTH the slug and the body (survives Slate)", () => {
    const built = buildProdMutatePost({ runId: 123456 });
    expect(built.slug).toContain("123456");
    expect(built.body).toContain(built.marker);
    expect(built.fileText).toContain(built.marker);
  });

  test("fileText round-trips through splitFrontMatter (well-formed front matter)", () => {
    const built = buildProdMutatePost({ runId: 99 });
    const { frontMatter, body } = splitFrontMatter(built.fileText, built.filePath);
    expect(frontMatter.startsWith("---")).toBe(true);
    // body keeps the leading "\n---\n" the helper slices in.
    expect(body.startsWith("\n---\n")).toBe(true);
  });

  test("composePost quotes a featured image path and leaves it empty by default", () => {
    expect(composePost({ title: "T", slug: "s", body: "b\n" })).toContain('featured_image: ""');
    const withImg = composePost({
      title: "T",
      slug: "s",
      body: "b\n",
      featuredImage: "/assets/images/uploads/x.png",
    });
    expect(withImg).toContain('featured_image: "/assets/images/uploads/x.png"');
  });

  test("missing runId throws loudly (no silent shared path)", () => {
    expect(() => buildProdMutatePost({})).toThrow(/requires a runId/);
    expect(() => buildMediaRoundtripPost({})).toThrow(/requires a runId/);
  });

  test("ephemeral posts are BUILDABLE when published — future-date trap guard (#1723 Cat 1)", () => {
    // THE dominant #1723 root cause: a prod-loop spec publishes a
    // future-dated `_posts/` entry, then waits for /blog/<slug>/ to serve a
    // run marker — but Jekyll SKIPS future-dated posts unless `_config.yml`
    // has `future: true`, so the URL 404s forever and the spec's
    // URL-reflect wait times out EVERY run. The ephemeral posts are dated
    // EPHEMERAL_DATE (a deliberately far-future date so they sort last and
    // are trivially per-run unique), so they only build when published if
    // `future: true` is set. This lock replaces the retired PROD_FIXTURES
    // "BUILDABLE when published" guard (the persistent canaries it iterated
    // are gone, #1771 step 4) — it keeps `future: true` lint-locked while
    // EPHEMERAL_DATE is a future date.
    const config = fs.readFileSync(path.join(REPO_ROOT, "_config.yml"), "utf8");
    const futureBuildsEnabled = /^future:\s*true\s*$/m.test(config);
    const todayUtcIso = new Date().toISOString().slice(0, 10);
    const isFutureDated = EPHEMERAL_DATE > todayUtcIso;
    if (isFutureDated) {
      expect(
        futureBuildsEnabled,
        `The ephemeral prod-loop posts are future-dated (${EPHEMERAL_DATE}) but _config.yml ` +
          `does not set 'future: true'. Jekyll will SKIP them even when published: true, so ` +
          `/blog/<slug>/ 404s and the prod loops' URL-reflect wait times out every run (#1723 ` +
          `Cat 1 root cause). Fix: set 'future: true' in _config.yml, OR give the ephemeral ` +
          `posts a non-future date (EPHEMERAL_DATE in e2e/prod-mutate-fixture.js).`,
      ).toBe(true);
    }
  });
});
