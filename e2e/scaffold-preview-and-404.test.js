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
// adamdaniel.ai/preview.md. The 404 page rides the gem `default` layout, which
// renders `page.robots` from front-matter, so 404.html DOES carry
// `robots: noindex,nofollow`.
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
  expect(fmField(text, "layout"), `${label}: layout`).toBe("default");
  expect(fmField(text, "sitemap"), `${label}: sitemap`).toBe("false");
  // default layout renders page.robots from front-matter → keep a real one.
  expect(fmField(text, "robots"), `${label}: robots`).toMatch(/noindex\s*,\s*nofollow/);
  // It must link back home so a lost visitor has a way out.
  expect(text, `${label}: links back to the homepage`).toMatch(/['"]\s*\/\s*['"]\s*\|\s*relative_url/);
  // Site-agnostic: no leaked adamdaniel identity.
  expect(text, `${label}: must not hardcode a specific site identity`).not.toMatch(/adamdaniel/i);
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
