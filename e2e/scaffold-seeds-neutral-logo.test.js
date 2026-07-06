// @lane: local — pure-fs invariant: the scaffolder seeds a NEUTRAL placeholder
// logo into every new site (issue #25). Runs scaffold/create-site.js into a
// throwaway dir and asserts the seeded assets/images/logo.svg exists, is a
// well-formed wordless SVG (no site-specific monogram), and tells the owner to
// replace it. This is the SCAFFOLD-OUTPUT half of the #25 guard; the gem-shipped
// placeholder itself is locked by theme/spec/neutral_logo_test.rb.
//
// BRANDING POLICY: the gem ships machinery + a neutral placeholder logo, never a
// site's brand. A new site gets its own replaceable copy at
// assets/images/logo.svg (shadows the gem asset) so its /admin shows a generic
// mark until the owner drops in their real logo.
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");

test.describe("scaffolder seeds a neutral placeholder logo (#25)", () => {
  let target;
  let logoText;

  test.beforeAll(() => {
    target = fs.mkdtempSync(path.join(os.tmpdir(), "cms25-scaffold-"));
    // Empty-dir guard in create-site.js rejects a non-empty target; mkdtemp gives
    // a fresh empty dir, so run the scaffolder straight into it.
    // --platform-ref pins the version so this test never hits the network.
    execFileSync(
      "node",
      [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
      { stdio: "pipe" },
    );
    const logoPath = path.join(target, "assets", "images", "logo.svg");
    expect(fs.existsSync(logoPath), `scaffolder must seed ${logoPath}`).toBe(true);
    logoText = fs.readFileSync(logoPath, "utf8");
  });

  test.afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  test("seeded logo is a well-formed SVG with the preserved viewBox", () => {
    expect(logoText).toMatch(/<svg\b/);
    expect(logoText).toMatch(/<\/svg>\s*$/);
    expect(logoText).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(logoText).toContain('viewBox="0 0 120 40"');
  });

  test("seeded logo is neutral — no site-specific monogram", () => {
    // The leaked brand rendered an "AD" monogram via <text>; a seed must render
    // no word/initials at all.
    expect(logoText).not.toMatch(/<text\b/i);
    const markup = logoText.replace(/<!--[\s\S]*?-->/g, "");
    for (const brand of ["AD", "Adam", "Daniel"]) {
      expect(markup).not.toMatch(new RegExp(`\\b${brand}\\b`, "i"));
    }
  });

  test("seeded logo tells the owner to replace it", () => {
    const comment = (logoText.match(/<!--([\s\S]*?)-->/) || [])[1] || "";
    expect(comment.length).toBeGreaterThan(0);
    expect(comment.toLowerCase()).toMatch(/replace|placeholder|your/);
  });
});
