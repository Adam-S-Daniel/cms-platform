// @lane: local — pure-fs/logic invariants for the shared public-content crawl set (#1771 Cat-2)
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, expect } = require("./base");
const {
  slugify,
  parseFrontMatterText,
  isPublished,
  isTestFixturePost,
  hasE2eSlugSignature,
} = require("./public-content");
const {
  EPHEMERAL_DATE,
  buildProdMutatePost,
  buildMediaRoundtripPost,
} = require("./prod-mutate-fixture");

// This module is the single source of truth the @parity content-crawl
// specs (console-clean, image-alt-text, sitemap) use to decide which
// `/blog/` posts are PUBLIC CONTENT vs E2E test fixtures. The whole point
// of #1771's Cat-2 fix is that a test-fixture canary — especially the
// ephemeral prod-loop post created through the Decap UI, which lands on
// `main` with `test_fixture: false` and NO `sitemap:` flag — must be
// excluded from the crawl so a transient orphan can't poison the REQUIRED
// e2e-admin / parity checks. These tests lock that classification.

// Front-matter shape Decap's "+ New Post" UI actually writes for an
// ephemeral prod-loop post (verified against the real `Create Post`
// commits): born `published: true`, future-dated, the markers the design
// WANTED (test_fixture/sitemap/robots) ABSENT because the posts
// collection declares no widget for them and `test_fixture` is a hidden
// `default: false`. This is the exact post that used to be crawled.
const UI_EPHEMERAL_MEDIA = [
  "---",
  "title: E2E Media Roundtrip 1779924060949",
  "slug: e2e-media-roundtrip-1779924060949",
  "date: 2099-12-31 00:00:00 +0000",
  "featured_image: /assets/images/uploads/e2e-media-roundtrip-1779924060949.png",
  "published: true",
  "test_fixture: false",
  "---",
  "body",
].join("\n");
const UI_EPHEMERAL_MEDIA_FILE = "2099-12-31-e2e-media-roundtrip-1779924060949.md";

test.describe("public-content crawl-set predicate (#1771 Cat-2)", () => {
  test("the UI-created ephemeral prod-loop post is excluded (the real failing case)", () => {
    const fm = parseFrontMatterText(UI_EPHEMERAL_MEDIA);
    // It is published (so the crawl WOULD otherwise enumerate it)…
    expect(isPublished(fm)).toBe(true);
    // …and it carries NEITHER the test_fixture flag NOR sitemap:false —
    // which is precisely why the old `sitemap: false` filter missed it.
    expect(fm.test_fixture).toBe("false");
    expect(fm.sitemap).toBeUndefined();
    // It MUST still be classified as a fixture via the structural slug
    // signature — from the on-disk filename AND from the bare URL slug
    // (sitemap-derived crawls only have the latter).
    expect(isTestFixturePost(fm, { filename: UI_EPHEMERAL_MEDIA_FILE })).toBe(true);
    expect(isTestFixturePost(fm, { urlSlug: "e2e-media-roundtrip-1779924060949" })).toBe(true);
  });

  test("excluded on test_fixture:true (the documented marker)", () => {
    const fm = parseFrontMatterText("---\ntitle: T\npublished: true\ntest_fixture: true\n---\nb");
    expect(isTestFixturePost(fm, { filename: "2026-01-01-some-fixture.md" })).toBe(true);
    // boolean true (not just the parsed string) is also honoured.
    expect(isTestFixturePost({ test_fixture: true })).toBe(true);
  });

  test("excluded on sitemap:false (the _e2e / unpublish-canary marker)", () => {
    const fm = parseFrontMatterText(
      "---\ntitle: E2E Unpublish Canary\nslug: e2e-unpublish-canary\npublished: false\nsitemap: false\ntest_fixture: true\n---\nb",
    );
    expect(isTestFixturePost(fm, { filename: "2024-01-02-e2e-unpublish-canary.md" })).toBe(true);
    expect(isTestFixturePost({ sitemap: false })).toBe(true);
    expect(isTestFixturePost({ sitemap: "false" })).toBe(true);
  });

  test("REAL public posts are NOT excluded — no false positives", () => {
    // A normal published post (no slug → title-derived) stays in the set.
    const real = parseFrontMatterText(
      "---\ntitle: Introducing GHA Bench\ndate: 2026-05-12 00:00:00 +0000\n---\nbody",
    );
    expect(isPublished(real)).toBe(true);
    expect(
      isTestFixturePost(real, {
        filename: "2026-05-12-introducing-gha-bench.md",
        urlSlug: slugify("Introducing GHA Bench"),
      }),
    ).toBe(false);
    // A real post whose TITLE merely contains "E2E" but whose slug does
    // NOT start with `e2e-` must not be misclassified.
    const realE2eTitle = parseFrontMatterText(
      "---\ntitle: E2E Testing Guide\nslug: testing-guide\npublished: true\n---\nb",
    );
    expect(
      isTestFixturePost(realE2eTitle, {
        filename: "2026-01-01-testing-guide.md",
        urlSlug: "testing-guide",
      }),
    ).toBe(false);
  });

  test("the e2e- slug signature matches both filename and URL slug, segment-anchored", () => {
    // Dated on-disk file slug (mirrors admin/posts-list-enhance.js's
    // /^\d{4}-\d{2}-\d{2}-e2e-/i).
    expect(hasE2eSlugSignature({ filename: "2099-12-31-e2e-prod-mutate-1.md" })).toBe(true);
    expect(hasE2eSlugSignature({ filename: "2024-01-02-e2e-unpublish-canary.md" })).toBe(true);
    // Bare URL slug.
    expect(hasE2eSlugSignature({ urlSlug: "e2e-prod-mutate-1" })).toBe(true);
    // Non-fixtures.
    expect(hasE2eSlugSignature({ filename: "2026-05-12-introducing-gha-bench.md" })).toBe(false);
    expect(hasE2eSlugSignature({ urlSlug: "introducing-gha-bench" })).toBe(false);
    // "e2e" must be at the START of the slug, not merely contained.
    expect(hasE2eSlugSignature({ urlSlug: "my-e2e-notes" })).toBe(false);
    expect(hasE2eSlugSignature({ filename: "2026-01-01-my-e2e-notes.md" })).toBe(false);
  });

  test("both ephemeral prod-loop builders + the composePost fallback are excluded", () => {
    // Whatever path the canary lands on `main` by — the genuinely
    // UI-driven create leg (no markers) OR the afterAll composePost
    // fallback (full markers) — it must be excluded.
    for (const built of [
      buildProdMutatePost({ runId: 7 }),
      buildMediaRoundtripPost({ runId: 7 }),
    ]) {
      const filename = path.basename(built.filePath);
      // composePost fallback text (full markers).
      const fallbackFm = parseFrontMatterText(built.fileText);
      expect(isTestFixturePost(fallbackFm, { filename })).toBe(true);
      // UI-shaped (strip the markers the UI never writes) — still excluded.
      const uiFm = { published: "true", date: `${EPHEMERAL_DATE} 00:00:00 +0000` };
      expect(isTestFixturePost(uiFm, { filename })).toBe(true);
      expect(isTestFixturePost(uiFm, { urlSlug: built.slug })).toBe(true);
    }
  });

  // ── Integration: replicate console-clean's _posts enumeration against a
  //    throw-away tree containing BOTH a real post and a UI-shaped ephemeral
  //    canary, and prove the canary URL is NOT enumerated while the real one
  //    is. This is the end-to-end "test_fixture posts are excluded from the
  //    public-content crawl set" lock the #1771 follow-up asks for.
  test("console-clean-style enumeration includes the real post, excludes the canary", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-posts-"));
    try {
      fs.writeFileSync(
        path.join(dir, "2026-05-12-introducing-gha-bench.md"),
        "---\ntitle: Introducing GHA Bench\ndate: 2026-05-12 00:00:00 +0000\n---\nbody\n",
      );
      fs.writeFileSync(path.join(dir, UI_EPHEMERAL_MEDIA_FILE), UI_EPHEMERAL_MEDIA);

      // The exact loop body console-clean.spec.js / sitemap.spec.js run.
      const urls = [];
      for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        const fm = parseFrontMatterText(fs.readFileSync(path.join(dir, file), "utf8"));
        if (!fm) continue;
        if (!isPublished(fm)) continue;
        if (isTestFixturePost(fm, { filename: file })) continue;
        const slugSource = fm.slug && fm.slug !== "" ? fm.slug : fm.title;
        if (!slugSource) continue;
        urls.push(`/blog/${slugify(slugSource)}/`);
      }

      expect(urls).toContain("/blog/introducing-gha-bench/");
      expect(urls).not.toContain("/blog/e2e-media-roundtrip-1779924060949/");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
