// @lane: local — pure-fs static invariant on the admin bundle pin
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Static guard against CDN drift in the admin bundle.
//
// Audit finding #11: every `<script src="https://unpkg.com/decap-cms…">`
// reference in admin/index*.html must carry a fully pinned, three-segment
// version (`decap-cms@X.Y.Z`). A `^`, `~`, or floating major lets unpkg
// resolve to whatever happens to be the latest matching release, which
// silently changes the bundle the editor loads from one page reload to
// the next. The publish loop is built around the EXACT bundle the test
// suite covers — drift here turns "passes locally" into "broken in prod
// next Tuesday".
//
// Audit finding #5: the Sveltia bundle silently dropped editorial-workflow
// support, so any reference to `sveltia-cms` is also forbidden.
//
// Pure node test — no browser, no webServer dependency.

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "admin");

function adminHtmlFiles() {
  return fs
    .readdirSync(ADMIN_DIR)
    .filter((f) => /^index.*\.html$/.test(f))
    .map((f) => path.join(ADMIN_DIR, f));
}

test.describe("admin/index*.html bundle invariants", () => {
  for (const file of adminHtmlFiles()) {
    const label = path.relative(REPO_ROOT, file);

    test(`${label}: every decap-cms unpkg URL is pinned to X.Y.Z`, () => {
      const html = fs.readFileSync(file, "utf8");
      const decapMatches = [...html.matchAll(/https:\/\/unpkg\.com\/decap-cms[^"']*/g)].map(
        (m) => m[0],
      );
      expect(
        decapMatches.length,
        `${label} should load the decap-cms bundle from unpkg`,
      ).toBeGreaterThan(0);
      for (const url of decapMatches) {
        // Must contain `decap-cms@X.Y.Z/dist/` — exact three-segment semver,
        // no range operator, no `latest`.
        expect(
          url,
          `${label}: decap-cms URL ${url} must pin to a full X.Y.Z version (no ^, ~, or floating major)`,
        ).toMatch(/decap-cms@\d+\.\d+\.\d+\/dist\//);
      }
    });

    test(`${label}: no sveltia-cms reference remains`, () => {
      const html = fs.readFileSync(file, "utf8");
      // Sveltia 0.158 silently dropped editorial-workflow support and
      // routed every Save straight to main, where branch protection
      // rejected it. Decap is the only supported bundle.
      expect(html.toLowerCase(), `${label} must not reference sveltia-cms`).not.toMatch(
        /sveltia-cms/,
      );
    });
  }
});
