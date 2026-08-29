// @lane: local — pure-fs invariant (+ optional post-build assertion): a
// scaffolded site exposes a WORKING admin "Live Preview" surface and a graceful
// not-found page (issue #23). The gem ships theme/_layouts/preview.html + the
// preview-bridge / native-preview-href admin scripts, but a "Live Preview" link
// dead-ends on a raw S3 404 unless the CONSUMING site provides the /preview/
// PAGE; likewise an unknown URL 404s ungracefully without a site 404.html. This
// lint locks the contract that the scaffolder seeds BOTH, and that the e2e
// fixture-site (which represents a scaffolded site) carries both, so the
// dead-button gap is caught in CI rather than by an editor clicking the button.
//
// Three assertions:
//   (a) scaffold/create-site.js into a throwaway dir emits preview.md (with
//       layout: preview, permalink: /preview/, sitemap: false) and 404.html.
//   (b) the e2e/fixture-site carries both files, IDENTICAL in shape to the seed.
//   (c) [opt, when a Jekyll toolchain is available] after a local build of the
//       fixture, _site/preview/index.html and _site/404.html exist and the
//       preview page renders the gem preview shell (data-preview-root).
//
// PREVIEW FRONT-MATTER / robots: the gem preview layout
// (theme/_layouts/preview.html) HARDCODES `<meta name="robots"
// content="noindex, nofollow">`, so the seeded preview.md deliberately OMITS a
// front-matter `robots` (a second one would double the meta) — mirroring
// adamdaniel.ai/preview.md.
//
// 404 SELF-CONTAINMENT (redesigned, issue #326): 404.html used to ride the gem
// `default` layout, which is adamdaniel.ai's whole opinionated dark/monospace
// look — fine for a site that IS that look, jarring for a site with its own
// design system (e.g. a light single-page bio) whose only gem-styled surface
// in a visitor's path was the 404. The seed now carries NO `layout:` at all —
// it is its own full <html> document with its own minimal, neutral,
// system-font styling and a SMALL set of `--nf-*` CSS custom properties a
// site can retune. LOCKED regardless of restyle: `permalink: /404.html`
// (correct HTTP 404 behavior), `robots: noindex,nofollow` + `sitemap: false`,
// and a working link home. Because it has no layout to render `page.robots`
// FOR it, the page emits its own `<meta name="robots">` reading the front
// matter field directly — so it still carries a real noindex,nofollow.
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");
const FIXTURE_ROOT = path.join(REPO_ROOT, "e2e", "fixture-site");

// Pull the value of a single-line `key: value` front-matter field (value may be
// quoted). Returns null when absent.
function fmField(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"));
  if (!m) return null;
  return m[1].replace(/^["']|["']$/g, "");
}

// Split the leading `---\n…\n---` YAML front-matter block from the body.
function frontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  return m ? m[1] : null;
}

function assertPreviewContract(label, text) {
  const fm = frontMatter(text);
  expect(fm, `${label}: must open with a YAML front-matter block`).not.toBeNull();
  expect(fmField(text, "layout"), `${label}: layout`).toBe("preview");
  expect(fmField(text, "permalink"), `${label}: permalink`).toBe("/preview/");
  expect(fmField(text, "sitemap"), `${label}: sitemap`).toBe("false");
  // The gem preview layout hardcodes the robots meta; the page MUST NOT add a
  // duplicate via front-matter (mirrors adamdaniel.ai/preview.md).
  expect(fmField(fm, "robots"), `${label}: must NOT carry a front-matter robots (gem layout hardcodes it)`).toBeNull();
}

function assert404Contract(label, text) {
  const fm = frontMatter(text);
  expect(fm, `${label}: must open with a YAML front-matter block`).not.toBeNull();
  // Self-contained (#326): NO layout — riding the gem `default` layout is
  // exactly the dependency this redesign removes, so a returning `layout:`
  // field (of any value, including "default") is a regression.
  expect(fmField(text, "layout"), `${label}: must carry NO layout (self-contained page)`).toBeNull();
  // LOCKED bits that a restyle must never lose:
  expect(fmField(text, "permalink"), `${label}: permalink`).toBe("/404.html");
  expect(fmField(text, "sitemap"), `${label}: sitemap`).toBe("false");
  // No layout renders page.robots FOR this page anymore — it must emit its
  // own <meta name="robots"> reading the front-matter field directly.
  expect(fmField(text, "robots"), `${label}: front-matter robots`).toMatch(/noindex\s*,\s*nofollow/);
  expect(text, `${label}: must emit its own <meta name="robots"> (no layout does it now)`).toMatch(
    /<meta\s+name="robots"\s+content="\{\{\s*page\.robots\s*\}\}"/,
  );
  // It must link back home so a lost visitor has a way out.
  expect(text, `${label}: links back to the homepage`).toMatch(/['"]\s*\/\s*['"]\s*\|\s*relative_url/);
  // Site-agnostic: no leaked adamdaniel identity.
  expect(text, `${label}: must not hardcode a specific site identity`).not.toMatch(/adamdaniel/i);
  // Self-contained proof: its own full document, not a fragment relying on a
  // layout to supply <html>/<head>/<body>.
  expect(text, `${label}: must be a full standalone <html> document`).toMatch(/<!DOCTYPE html>/i);
  expect(text, `${label}: must close its own <html> document`).toMatch(/<\/html>\s*$/i);
  // No dependence on the gem's opinionated default layout/stylesheet — the
  // whole point of the redesign (#326).
  expect(text, `${label}: must not load the gem's assets/css/main.css`).not.toMatch(/assets\/css\/main\.css/);
  expect(text, `${label}: must not include the gem header/footer chrome`).not.toMatch(
    /\{%\s*include\s+(header|footer)\.html\s*%\}/,
  );
  // Brandable via a SMALL set of CSS custom properties a site can retune
  // in place, rather than needing to redesign the whole page.
  const customProps = text.match(/--[\w-]+\s*:/g) || [];
  expect(
    customProps.length,
    `${label}: must expose a few CSS custom properties for brand overrides`,
  ).toBeGreaterThanOrEqual(3);
}

test.describe("scaffolder + fixture expose /preview/ and a 404 page (#23)", () => {
  let target;
  let scaffPreview;
  let scaff404;

  test.beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "cms23-scaffold-"));
    // --platform-ref pins the version so this test never hits the network.
    execFileSync(
      "node",
      [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
      { stdio: "pipe" },
    );
    const previewPath = path.join(target, "preview.md");
    const notFoundPath = path.join(target, "404.html");
    expect(fs.existsSync(previewPath), `scaffolder must seed ${previewPath}`).toBe(true);
    expect(fs.existsSync(notFoundPath), `scaffolder must seed ${notFoundPath}`).toBe(true);
    scaffPreview = fs.readFileSync(previewPath, "utf8");
    scaff404 = fs.readFileSync(notFoundPath, "utf8");
  });

  test.afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  // ── (a) scaffold output ──────────────────────────────────────────────
  test("(a) scaffolded preview.md is a body-less preview shell", () => {
    assertPreviewContract("scaffold preview.md", scaffPreview);
    // Front-matter ONLY — no body content (the gem layout IS the shell).
    const body = scaffPreview.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
    expect(body, "scaffold preview.md: front-matter only, no body").toBe("");
  });

  test("(a) scaffolded 404.html is a graceful not-found page", () => {
    assert404Contract("scaffold 404.html", scaff404);
  });

  // ── (b) fixture parity ───────────────────────────────────────────────
  test("(b) fixture-site carries preview.md + 404.html in the same shape", () => {
    const fxPreview = path.join(FIXTURE_ROOT, "preview.md");
    const fx404 = path.join(FIXTURE_ROOT, "404.html");
    expect(fs.existsSync(fxPreview), `fixture must carry ${fxPreview}`).toBe(true);
    expect(fs.existsSync(fx404), `fixture must carry ${fx404}`).toBe(true);
    assertPreviewContract("fixture preview.md", fs.readFileSync(fxPreview, "utf8"));
    assert404Contract("fixture 404.html", fs.readFileSync(fx404, "utf8"));
  });

  // ── (c) optional post-build proof ────────────────────────────────────
  // Builds the fixture with the gem if a Jekyll toolchain is available, then
  // asserts the rendered /preview/ + /404.html exist and the preview page
  // carries the gem preview shell marker (data-preview-root). Skipped (not
  // failed) when bundler/jekyll aren't installed — the pure-fs self-CI lane
  // (node-unit-lints) has no Ruby toolchain, so this stays green there while
  // still running in any environment that CAN build (dogfood / local dev).
  test("(c) built fixture renders /preview/ + /404.html with the preview shell", () => {
    const hasBundle = (() => {
      try {
        execFileSync("bundle", ["--version"], { stdio: "pipe" });
        return fs.existsSync(path.join(FIXTURE_ROOT, "Gemfile.lock"));
      } catch (_) {
        return false;
      }
    })();
    test.skip(!hasBundle, "no Jekyll toolchain (bundler + Gemfile.lock) available — pure-fs lanes skip the build");

    execFileSync("bundle", ["exec", "jekyll", "build", "--quiet"], {
      cwd: FIXTURE_ROOT,
      stdio: "pipe",
    });
    const site = path.join(FIXTURE_ROOT, "_site");
    const previewHtml = path.join(site, "preview", "index.html");
    const notFoundHtml = path.join(site, "404.html");
    expect(fs.existsSync(previewHtml), `built ${previewHtml}`).toBe(true);
    expect(fs.existsSync(notFoundHtml), `built ${notFoundHtml}`).toBe(true);
    // The gem preview layout's hosting shell — the marker the admin
    // preview-bridge streams content into.
    expect(fs.readFileSync(previewHtml, "utf8")).toMatch(/data-preview-root/);
  });
});
