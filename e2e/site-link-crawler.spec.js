// @lane: local — pure-fs crawl of the BUILT _site; no browser, no server, no network.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

// Public-site internal link crawler.
//
// Walks every built HTML page under `_site/` (excluding the admin shell),
// harvests every `<a href>` that points back at this site, and asserts the
// target actually exists in the build. Catches the "a whole section's links
// point at pages the build never wrote" regression class.
//
// WHY THIS EXISTS
// e2e/cms-link-crawler.spec.js crawls the ADMIN only — it walks
// /admin/index-local.html for the five platform base collections and HEADs what
// the admin surfaces. Nothing crawled the PUBLIC pages, so a site could ship a
// page whose every link 404s and every lane stayed green.
//
// That is not hypothetical. jodidaniel.com's home page rendered its 16 media
// items as `{{ item.url }}`, intending the front-matter `url:` key holding each
// article's address. But for a Jekyll collection DOCUMENT, `url` is the
// document's OWN address: `Jekyll::Drops::DocumentDrop` defines `url`, and a
// Drop resolves its defined methods BEFORE falling back to front matter — so
// the front-matter value was unreachable from Liquid and every link rendered as
// `/media/<slug>/`. That collection was `output: false`, so those pages were
// never written and all 16 links 404'd. The build succeeded, every spec passed,
// and it surfaced only when a human clicked one on a preview deploy.
//
// The shadowing is site-authored and not the platform's to prevent. The MISSING
// TARGET is generic, cheap to detect from the build output alone, and is what
// this spec asserts.
//
// SCOPE — deliberately `<a href>` only. Navigation links are the bug class
// above; `<img src>` / `<link href>` assets are covered by the media sentinel
// (checkMediaProbeSentinel) and by the visual-regression lane, which SEE a
// broken asset. An anchor to a missing page is invisible to both.

const SITE_ROOT = process.env.SITE_ROOT || path.join(__dirname, "..");
const SITE = path.join(SITE_ROOT, "_site");

// Jekyll's `baseurl` prefixes every `relative_url` link. Strip it before
// resolving against `_site/`, which is written WITHOUT it.
function readBaseurl() {
  try {
    const cfg = YAML.parse(fs.readFileSync(path.join(SITE_ROOT, "_config.yml"), "utf8"));
    const b = cfg && typeof cfg.baseurl === "string" ? cfg.baseurl.trim() : "";
    return b.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function walkHtml(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    // The admin is gem-copied machinery with its own crawler
    // (cms-link-crawler.spec.js) and its own hash-routed link shapes.
    if (e.isDirectory()) {
      if (full === path.join(SITE, "admin")) continue;
      walkHtml(full, out);
    } else if (e.isFile() && e.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

// `<a ... href="...">` only. Quoted attribute values; Jekyll/kramdown emit
// nothing else, and an unquoted href would be invalid HTML5 for these paths.
function anchorHrefs(html) {
  const out = [];
  const re = /<a\b[^>]*?\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const SKIP_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function isInternal(href) {
  if (!href) return false;
  if (href.startsWith("#")) return false; // same-page fragment
  if (SKIP_SCHEME.test(href)) return false; // mailto:, tel:, http(s):, //cdn
  return true;
}

// Resolve an internal href to the file `_site` must contain, or null when the
// href addresses the current page itself (a bare "?q" / "#frag").
function resolveTarget(href, pageFile, baseurl) {
  let p = href.split("#")[0].split("?")[0];
  if (p === "") return null;

  let abs;
  if (p.startsWith("/")) {
    if (baseurl && (p === baseurl || p.startsWith(`${baseurl}/`))) p = p.slice(baseurl.length) || "/";
    abs = path.join(SITE, p);
  } else {
    abs = path.resolve(path.dirname(pageFile), p);
  }

  // A trailing slash always means the directory's index.
  if (p.endsWith("/")) return [path.join(abs, "index.html")];
  // Otherwise accept the file itself, its index, or its .html sibling —
  // extensionless permalinks and `foo.html` links are both legal.
  return [abs, path.join(abs, "index.html"), `${abs}.html`];
}

test.describe("public site internal links", () => {
  test("every <a href> into this site resolves to a built file", () => {
    expect(
      fs.existsSync(SITE),
      `${SITE} does not exist — this spec runs in the lane that builds the site.`,
    ).toBe(true);

    const baseurl = readBaseurl();
    const pages = walkHtml(SITE);
    expect(pages.length, `no built HTML pages found under ${SITE}`).toBeGreaterThan(0);

    const broken = [];
    let checked = 0;

    for (const pageFile of pages) {
      const html = fs.readFileSync(pageFile, "utf8");
      for (const href of anchorHrefs(html)) {
        if (!isInternal(href)) continue;
        const candidates = resolveTarget(href, pageFile, baseurl);
        if (candidates === null) continue;
        checked += 1;
        // Never let a traversal escape the build directory.
        if (!candidates.some((c) => c === SITE || c.startsWith(SITE + path.sep))) {
          broken.push({ page: pageFile, href, why: "resolves outside _site" });
          continue;
        }
        if (!candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
          broken.push({ page: pageFile, href, why: "no such file in the build" });
        }
      }
    }

    // Report EVERY broken link, not just the first — one root cause (a
    // collection left at `output: false`) breaks a whole section at once, and
    // seeing all of them is what makes that obvious.
    const detail = broken
      .map(
        ({ page, href, why }) => `  ${path.relative(SITE, page)}  ->  ${href}   (${why})`,
      )
      .join("\n");

    expect(
      broken.length,
      `${broken.length} of ${checked} internal link(s) in _site point at pages the build never wrote:\n${detail}\n\n` +
        `Each line is "<page that links> -> <href>". A whole section breaking at once usually means its\n` +
        `collection is \`output: false\` in _config.yml while the layout links to each item's page, or a\n` +
        `permalink changed without the linking layout following.`,
    ).toBe(0);
  });
});
