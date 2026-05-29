// Pure helper: remove <url> blocks from a jekyll-sitemap XML string.
//
// Why this exists: cms-publish-flow.spec.js creates a smoke post via the
// local Decap backend, runs `jekyll build` into the SHARED `_site/` the
// Playwright webServer serves, then cleans up. Its cleanup deletes the
// rendered `_site/blog/<slug>/` (and the manufactured tag archive) but the
// built `_site/sitemap.xml` still advertises those <loc>s — so they 404.
// image-alt-text.spec.js runs in the SAME e2e-admin job, shares that
// `_site/`, walks the sitemap, and fails on the orphaned 404 ("expected
// 200 from /blog/e2e-publish-flow-smoke/, got 404"). Pruning the orphaned
// <url> blocks on cleanup keeps the sitemap consistent with what's on disk.
//
// Kept as a pure, exported function so it's unit-testable without booting
// Jekyll, Decap, or a browser (see sitemap-prune.test.js).

// Remove every <url>…</url> block whose body contains any of `locNeedles`
// (matched as plain substrings against the block text, which includes the
// full <loc> URL). Returns the cleaned XML; unmatched input is returned
// unchanged. Robust to attribute/whitespace variation because it slices on
// the <url> element boundaries rather than parsing the whole document.
function pruneSitemapUrls(xml, locNeedles) {
  if (!xml || !Array.isArray(locNeedles) || locNeedles.length === 0) {
    return xml;
  }
  return xml.replace(/<url>[\s\S]*?<\/url>\s*/g, (block) =>
    locNeedles.some((needle) => needle && block.includes(needle)) ? "" : block,
  );
}

module.exports = { pruneSitemapUrls };
