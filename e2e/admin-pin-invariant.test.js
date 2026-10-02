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
// Subresource Integrity: an exact version still trusts unpkg to serve the
// bytes it served when the pin was reviewed, and this bundle runs with the
// editor's GitHub token in reach. So every Decap `<script>` tag also carries
// `integrity="sha384-…"` plus `crossorigin="anonymous"` (SRI needs a CORS
// fetch), and every shell pinning the same version carries the SAME hash, so a
// version bump that recomputes it in one shell cannot leave another unchecked.
//
// Audit finding #5: the Sveltia bundle silently dropped editorial-workflow
// support, so any reference to `sveltia-cms` is also forbidden.
//
// Pure node test — no browser, no webServer dependency.

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "theme", "admin");

function adminHtmlFiles() {
  return fs
    .readdirSync(ADMIN_DIR)
    .filter((f) => /^index.*\.html$/.test(f))
    .map((f) => path.join(ADMIN_DIR, f));
}

// The opening `<script …>` tags that load Decap from unpkg. Comments are
// stripped first so prose about a tag is never mistaken for one.
function decapScriptTags(html) {
  const live = html.replace(/<!--[\s\S]*?-->/g, "");
  return [...live.matchAll(/<script\b[^>]*\bsrc="https:\/\/unpkg\.com\/decap-cms[^"]*"[^>]*>/g)].map(
    (m) => m[0],
  );
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
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

    test(`${label}: every decap-cms script tag carries SRI (sha384 + crossorigin)`, () => {
      const tags = decapScriptTags(fs.readFileSync(file, "utf8"));
      expect(tags.length, `${label} should load the decap-cms bundle from unpkg`).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(
          attr(tag, "integrity"),
          `${label}: ${tag} must carry integrity="sha384-<64 base64 chars>"`,
        ).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
        expect(
          attr(tag, "crossorigin"),
          `${label}: ${tag} must carry crossorigin="anonymous" — SRI needs a CORS request`,
        ).toBe("anonymous");
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

  test("shells pinning the same decap-cms version carry the same integrity hash", () => {
    const hashesByVersion = new Map();
    for (const file of adminHtmlFiles()) {
      for (const tag of decapScriptTags(fs.readFileSync(file, "utf8"))) {
        const version = /decap-cms@(\d+\.\d+\.\d+)\//.exec(attr(tag, "src") || "")?.[1];
        if (!version) continue;
        const seen = hashesByVersion.get(version) || new Map();
        seen.set(path.relative(REPO_ROOT, file), attr(tag, "integrity"));
        hashesByVersion.set(version, seen);
      }
    }
    expect(hashesByVersion.size, "no shell pins an exact decap-cms version").toBeGreaterThan(0);
    for (const [version, byFile] of hashesByVersion) {
      expect(
        new Set(byFile.values()).size,
        `decap-cms@${version} has different integrity values across shells: ${JSON.stringify([...byFile])}`,
      ).toBe(1);
    }
  });
});
