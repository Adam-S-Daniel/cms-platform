// @lane: local — self-contained ruby render under a stripped locale; pure fs +
// child_process, no browser, no network.
//
// Regression lint for #213: scripts/render-decap-config.rb is the deploy-time
// Decap config renderer, and it died with `invalid byte sequence in
// US-ASCII (ArgumentError)` in any shell with no LANG/LC_ALL set. Ruby derives
// Encoding.default_external from the ambient locale; with no locale it
// resolves to US-ASCII, so File.read tags theme/admin/config.base.yml's
// legitimate UTF-8 (em-dashes in its load-bearing comments) as US-ASCII, and
// the first `sub`/`gsub` over that text raises. CI never caught this because
// ubuntu-latest happens to export LANG=C.UTF-8 — but the renderer is a
// deploy-time CLI a contributor or a differently-configured runner can invoke
// from a shell that sets no locale at all, and it must not depend on one.
//
// This drives the REAL renderer against a throwaway fixture with the
// ambient locale stripped from the child process, and asserts it still
// succeeds and preserves the non-ASCII byte. Runs in the platform self-CI
// node-unit-lints lane (TARGET=prod): no Jekyll, no browser — just `ruby`
// (already on the lane's runner for the theme specs) + fs. Self-skips if
// `ruby` or the platform render sources are absent (e.g. a consumer
// checkout), like its sibling field-library-ref-render.test.js.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect } = require("./base");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "render-decap-config.rb");
const BASE = path.join(ROOT, "theme", "admin", "config.base.yml");
const FIELD_LIBRARY = path.join(ROOT, "theme", "admin", "field_library.yml");

function rubyAvailable() {
  const r = spawnSync("ruby", ["--version"], { encoding: "utf8" });
  return !r.error && r.status === 0;
}

// The platform render sources only exist in the platform checkout; in a
// consumer the harness is placed at the site root and they're absent.
const havePlatform =
  fs.existsSync(SCRIPT) && fs.existsSync(BASE) && fs.existsSync(FIELD_LIBRARY) && rubyAvailable();

const NON_ASCII = "—"; // em-dash — the real-world case (config.base.yml's comments)

// Build a throwaway fixture site whose admin/ carries the base machinery (so
// the renderer's gem-less fallback resolves it), then render it with the
// child process's locale env vars stripped — the exact condition #213 hit.
function renderWithLocaleStripped(dir) {
  const admin = path.join(dir, "admin");
  fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "_config.yml"),
    'title: Locale Fixture\nurl: "https://locale.example"\ncms:\n  repository: Adam-S-Daniel/locale-fixture\n  oauth_base_url: ""\n',
  );
  fs.copyFileSync(BASE, path.join(admin, "config.base.yml"));
  fs.copyFileSync(FIELD_LIBRARY, path.join(admin, "field_library.yml"));
  const out = path.join(dir, "_site");
  // Strip LANG/LC_ALL/LANGUAGE from the CHILD process only — the harness
  // itself keeps running under whatever locale invoked it. This is the one
  // difference from field-library-ref-render.test.js's spawnSync call: that's
  // the point of this test.
  return spawnSync("ruby", [SCRIPT, dir, out], {
    encoding: "utf8",
    env: { ...process.env, LANG: "", LC_ALL: "", LANGUAGE: "" },
  });
}

// This assertion is a pure source-text read of scripts/render-decap-config.rb
// — it never shells out to `ruby` — so it is DELIBERATELY kept in its own
// describe, gated only on the script existing (not on `rubyAvailable()`), so
// the encoding pin stays guarded even on a machine with no Ruby installed.
test.describe("render-decap-config.rb pins its encoding (#213)", () => {
  test.skip(!fs.existsSync(SCRIPT), "platform render script absent — platform-only render lint");

  test("the script pins Encoding.default_external so it doesn't inherit a US-ASCII guess from an unset LANG", () => {
    const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
    expect(
      scriptSrc,
      "without pinning Encoding.default_external, a shell with no LANG resolves Ruby's default external encoding to US-ASCII, and File.read over config.base.yml's UTF-8 em-dashes raises 'invalid byte sequence in US-ASCII' (#213) — this must be set before the first file read",
    ).toMatch(/Encoding\.default_external\s*=\s*Encoding::UTF_8/);
  });
});

test.describe("render-decap-config.rb does not depend on the ambient locale (#213)", () => {
  test.skip(!havePlatform, "platform render sources / ruby absent — platform-only render lint");

  test("theme/admin/config.base.yml genuinely contains non-ASCII (so this test can't silently become ASCII-only)", () => {
    const baseText = fs.readFileSync(BASE, "utf8");
    expect(
      baseText,
      "config.base.yml must contain a non-ASCII character (e.g. an em-dash) for this regression test to mean anything — otherwise it would pass even with the bug present",
    ).toContain(NON_ASCII);
  });

  test("renders successfully with LANG/LC_ALL/LANGUAGE stripped, preserving the non-ASCII byte intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locale-render-"));
    const r = renderWithLocaleStripped(dir);
    expect(
      r.status,
      `render-decap-config.rb must not depend on the ambient locale (#213) — it should succeed with no LANG/LC_ALL set, but exited ${r.status} with:\n${r.stderr}`,
    ).toBe(0);

    const rendered = fs.readFileSync(path.join(dir, "_site", "admin", "config.yml"), "utf8");
    expect(
      rendered,
      "the rendered config must still carry the non-ASCII byte intact (not mojibake, not stripped to '?')",
    ).toContain(NON_ASCII);
  });
});
