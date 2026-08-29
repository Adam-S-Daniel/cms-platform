// @lane: local — pure-fs invariant: the scaffolder seeds a NEUTRAL placeholder
// favicon into every new site AND the gem-owned <head> partial that references
// it actually gets emitted (issue #325). Mirrors
// e2e/scaffold-seeds-neutral-logo.test.js (the #25 logo pattern this one
// reuses), plus a head-emission half that #25's guard doesn't need (the logo
// is only read by the /admin config renderer, never emitted into a page
// <head>).
//
// BRANDING POLICY: same shadowing pattern as the logo — the gem ships
// machinery + a neutral placeholder icon, never a site's brand. A new site
// gets its own replaceable copy at assets/favicon.svg (shadows the gem asset)
// so browser tabs show a generic mark until the owner drops in a real one.
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");
const GEM_FAVICON = path.join(REPO_ROOT, "theme", "assets", "favicon.svg");
const FAVICON_INCLUDE = path.join(REPO_ROOT, "theme", "_includes", "favicon.html");
const LAYOUTS_DIR = path.join(REPO_ROOT, "theme", "_layouts");

test.describe("scaffolder seeds a neutral favicon (#325)", () => {
  let target;
  let faviconText;

  test.beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "cms325-scaffold-"));
    // --platform-ref pins the version so this test never hits the network.
    execFileSync(
      "node",
      [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
      { stdio: "pipe" },
    );
    const faviconPath = path.join(target, "assets", "favicon.svg");
    expect(fs.existsSync(faviconPath), `scaffolder must seed ${faviconPath}`).toBe(true);
    faviconText = fs.readFileSync(faviconPath, "utf8");
  });

  test.afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  // ── scaffold output ──────────────────────────────────────────────────
  test("seeded favicon is a well-formed, square SVG", () => {
    expect(faviconText).toMatch(/<svg\b/);
    expect(faviconText).toMatch(/<\/svg>\s*$/);
    expect(faviconText).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(faviconText).toMatch(/viewBox="0 0 (\d+) \1"/);
  });

  test("seeded favicon is neutral — no site-specific monogram", () => {
    expect(faviconText).not.toMatch(/<text\b/i);
    const markup = faviconText.replace(/<!--[\s\S]*?-->/g, "");
    for (const brand of ["AD", "Adam", "Daniel"]) {
      expect(markup).not.toMatch(new RegExp(`\\b${brand}\\b`, "i"));
    }
  });

  test("seeded favicon tells the owner to replace it", () => {
    const comment = (faviconText.match(/<!--([\s\S]*?)-->/) || [])[1] || "";
    expect(comment.length).toBeGreaterThan(0);
    expect(comment.toLowerCase()).toMatch(/replace|placeholder|your/);
  });

  test("scaffolded favicon is byte-derived from the gem asset (no drift)", () => {
    const gemFavicon = fs.readFileSync(GEM_FAVICON, "utf8");
    // The seed prepends a "replace me" note but must otherwise carry the
    // gem's own <svg> body verbatim.
    const gemSvgBody = gemFavicon.slice(gemFavicon.indexOf("<svg"));
    expect(faviconText).toContain(gemSvgBody.trim());
  });
});

test.describe("gem-shipped favicon asset (#325)", () => {
  test("theme/assets/favicon.svg exists and is well-formed", () => {
    expect(fs.existsSync(GEM_FAVICON), `gem must ship ${GEM_FAVICON}`).toBe(true);
    const svg = fs.readFileSync(GEM_FAVICON, "utf8");
    expect(svg).toMatch(/<svg\b/);
    expect(svg).toMatch(/<\/svg>\s*$/);
  });
});

test.describe("favicon <head> emission is real, not just documented (#325)", () => {
  test("theme/_includes/favicon.html exists and emits a <link rel=\"icon\"> honoring cms.favicon_url", () => {
    expect(fs.existsSync(FAVICON_INCLUDE), `gem must ship ${FAVICON_INCLUDE}`).toBe(true);
    const include = fs.readFileSync(FAVICON_INCLUDE, "utf8");
    expect(include).toMatch(/<link\s+rel="icon"/);
    // Site override honored verbatim (mirrors cms.logo_url's own-value-wins
    // behavior in theme/lib/cms-platform-theme/decap_config_hook.rb).
    expect(include).toMatch(/site\.cms\.favicon_url/);
    // Default path points at the neutral gem/shadowable asset, baseurl-aware.
    expect(include).toMatch(/assets\/favicon\.svg/);
    expect(include).toMatch(/relative_url/);
  });

  test("default.html <head> includes favicon.html", () => {
    const defaultLayout = fs.readFileSync(path.join(LAYOUTS_DIR, "default.html"), "utf8");
    const headMatch = defaultLayout.match(/<head>([\s\S]*?)<\/head>/);
    expect(headMatch, "default.html must have a <head>...</head> block").not.toBeNull();
    expect(headMatch[1]).toMatch(/\{%\s*include\s+favicon\.html\s*%\}/);
  });

  test("every other gem layout rides default.html's <head> (so the favicon include covers it too)", () => {
    // Real coverage check, not an assumption: every *.html layout other than
    // default.html itself must declare `layout: default` in its own front
    // matter, so it inherits default.html's <head> (and therefore the
    // favicon include) rather than defining a competing one. If a future
    // layout opts out of `layout: default`, this test fails loud instead of
    // silently losing favicon coverage on that layout.
    const layoutFiles = fs
      .readdirSync(LAYOUTS_DIR)
      .filter((f) => f.endsWith(".html") && f !== "default.html");
    expect(layoutFiles.length, "expected at least one non-default gem layout to check").toBeGreaterThan(0);
    for (const f of layoutFiles) {
      const text = fs.readFileSync(path.join(LAYOUTS_DIR, f), "utf8");
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `${f}: must open with YAML front matter`).not.toBeNull();
      expect(fm[1], `${f}: must declare layout: default to inherit the favicon <head>`).toMatch(
        /^layout:\s*default\s*$/m,
      );
    }
  });
});
