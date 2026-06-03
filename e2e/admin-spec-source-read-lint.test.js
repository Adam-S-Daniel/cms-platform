// @lane: local — pure-fs guard: consumer-facing specs must not read admin SOURCE from the platform tree.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// WHY THIS LINT EXISTS
// --------------------
// As of v0.1.4 the admin/ machinery ships INSIDE the cms-platform-theme gem
// (theme/admin) and consuming sites DELETE their vendored admin/. The e2e
// harness is reused by consumers (playwright.config.js CONSUMER mode), where
// the specs run from <site>/e2e and there is NO theme/admin (nor a vendored
// <site>/admin) source tree — only the gem-RENDERED _site/admin/* the build
// emits.
//
// So a spec that runs in consumer mode must NOT read an admin file from the
// platform SOURCE tree (theme/admin, or the legacy vendored ../admin). It must
// instead read the bytes the site actually serves — fetch over the served
// origin (`page.request.get('/admin/<file>')`) or read the rendered
// `${SITE_ROOT}/_site/admin/<file>` (the pattern in cms-config.spec.js et al.).
//
// preview-bridge.spec.js regressed exactly this way: it `fs.readFileSync`'d
// `path.join(__dirname, '..', 'theme', 'admin', 'preview-bridge.js')`, which
// passed platform self-CI (theme/admin exists locally) but ENOENT'd in every
// consumer e2e run (adamdaniel.ai #1883). Platform self-CI runs only the
// pure-fs *.test.js lints — it never builds+serves the fixture and runs the
// browser specs in consumer context — so nothing caught it pre-release. This
// lint is the cheap, deterministic guard that does.
//
// PLATFORM_META_SPECS are exempt: they are testIgnore'd in CONSUMER mode
// (playwright.config.js) and only ever run in the platform's own self-CI
// against the platform tree, so reading admin source is legitimate for them.

const E2E_DIR = __dirname;
const CONFIG = path.join(E2E_DIR, "playwright.config.js");

// Parse the PLATFORM_META_SPECS array out of playwright.config.js (its source
// of truth) so this lint stays in lockstep without importing the config (which
// has env/webServer side effects).
function metaSpecs() {
  const src = fs.readFileSync(CONFIG, "utf8");
  const m = src.match(/const PLATFORM_META_SPECS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("could not locate PLATFORM_META_SPECS in playwright.config.js");
  return new Set([...m[1].matchAll(/["'`]([^"'`]+\.(?:spec|test)\.js)["'`]/g)].map((x) => x[1]));
}

// Strip comments before scanning — a comment may legitimately MENTION
// theme/admin (e.g. explaining why we DON'T read it). Block comments + line
// comments; the `[^:]` guard on `//` spares URL schemes like `https://`.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Source-tree admin reads (forbidden in consumer-facing specs). These match a
// filesystem path into theme/admin or the legacy vendored ../admin — NOT a
// served URL ("/admin/..."), NOT the rendered "_site/admin/..." output.
const FORBIDDEN = [
  { re: /theme["'`]\s*,\s*["'`]admin/, hint: 'path.join(..., "theme", "admin", ...)' },
  { re: /theme\/admin/, hint: '"theme/admin/..." path literal' },
  { re: /\.\.["'`]\s*,\s*["'`]admin["'`]/, hint: 'path.join(__dirname, "..", "admin", ...) (legacy vendored)' },
  { re: /["'`]\.\.\/admin[/"'`]/, hint: '"../admin/..." path literal (legacy vendored)' },
];

test.describe("admin specs must not read admin SOURCE from the platform tree (consumer-safe)", () => {
  const meta = metaSpecs();
  const specs = fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.js"))
    .filter((f) => !meta.has(f));

  test("the meta-spec allowlist resolved (lint is wired to playwright.config.js)", () => {
    expect(meta.size, "PLATFORM_META_SPECS parsed from playwright.config.js").toBeGreaterThan(0);
  });

  for (const spec of specs) {
    test(`${spec} reads admin from the served site, not the platform source tree`, () => {
      const src = stripComments(fs.readFileSync(path.join(E2E_DIR, spec), "utf8"));
      const hits = FORBIDDEN.filter(({ re }) => re.test(src)).map(({ hint }) => hint);
      expect(
        hits,
        `${spec} reads the admin SOURCE tree (${hits.join("; ")}). Consumers have no theme/admin ` +
          `(admin ships via the gem since v0.1.4). Fetch the served bytes instead — ` +
          `\`await (await page.request.get('/admin/<file>')).text()\` — or read the rendered ` +
          `\`path.join(SITE_ROOT, '_site', 'admin', '<file>')\` (see cms-config.spec.js). If this ` +
          `spec is genuinely platform-only, add it to PLATFORM_META_SPECS in playwright.config.js.`,
      ).toEqual([]);
    });
  }
});
