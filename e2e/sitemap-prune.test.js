// @lane: local — pure-node unit test for e2e/sitemap-prune.js (no browser)
const { test, expect } = require("./base");
const { pruneSitemapUrls } = require("./sitemap-prune");

// jekyll-sitemap emits a flat <urlset> of <url><loc>…</loc>…</url> blocks.
// This mirrors the shape cms-publish-flow.spec.js's jekyllBuild() produces,
// including the orphaned smoke-post + manufactured-tag entries its cleanup
// must prune so image-alt-text.spec.js (shared _site) doesn't 404 on them.
const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>https://adamdaniel.ai/blog/introducing-gha-bench/</loc>
<lastmod>2026-05-12T00:00:00+00:00</lastmod>
</url>
<url>
<loc>https://adamdaniel.ai/blog/e2e-publish-flow-smoke/</loc>
<lastmod>2026-05-24T00:00:00+00:00</lastmod>
</url>
<url>
<loc>https://adamdaniel.ai/tags/e2e-smoke-flow-tag/</loc>
</url>
<url>
<loc>https://adamdaniel.ai/</loc>
</url>
</urlset>
`;

test.describe("sitemap-prune", () => {
  test("removes the orphaned smoke-post and tag URLs, keeps the rest", () => {
    const out = pruneSitemapUrls(SITEMAP, [
      "/blog/e2e-publish-flow-smoke/",
      "/tags/e2e-smoke-flow-tag/",
    ]);
    expect(out).not.toContain("/blog/e2e-publish-flow-smoke/");
    expect(out).not.toContain("/tags/e2e-smoke-flow-tag/");
    // Untouched URLs survive…
    expect(out).toContain("/blog/introducing-gha-bench/");
    expect(out).toContain("<loc>https://adamdaniel.ai/</loc>");
    // …and exactly two <url> blocks were removed (4 → 2).
    expect((out.match(/<url>/g) || []).length).toBe(2);
    // Still well-formed: every opening <url> has a matching close.
    expect((out.match(/<url>/g) || []).length).toBe((out.match(/<\/url>/g) || []).length);
    expect(out).toContain("</urlset>");
  });

  test("substring match doesn't over-prune a longer path that contains the needle", () => {
    const xml = `<urlset>
<url><loc>https://adamdaniel.ai/blog/smoke/</loc></url>
<url><loc>https://adamdaniel.ai/blog/smoke-test-results/</loc></url>
</urlset>`;
    // Needle "/blog/smoke/" has a trailing slash, so it must NOT match
    // "/blog/smoke-test-results/".
    const out = pruneSitemapUrls(xml, ["/blog/smoke/"]);
    expect(out).not.toContain("/blog/smoke/");
    expect(out).toContain("/blog/smoke-test-results/");
    expect((out.match(/<url>/g) || []).length).toBe(1);
  });

  test("no-ops when there are no needles or no match", () => {
    expect(pruneSitemapUrls(SITEMAP, [])).toBe(SITEMAP);
    expect(pruneSitemapUrls(SITEMAP, ["/blog/does-not-exist/"])).toBe(SITEMAP);
    expect(pruneSitemapUrls("", ["/x/"])).toBe("");
  });
});
