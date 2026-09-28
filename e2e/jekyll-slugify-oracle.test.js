// @lane: local — runs the SITE's own Jekyll (bundle exec) against e2e/jekyll-slugify-golden.json
/*
 * Every slugify the platform ships — the admin's live-url-derive.js, the
 * harness's public-content.js, cross_post.py, the theme spec helper — is a
 * port of Jekyll::Utils.slugify, and each is tested against
 * e2e/jekyll-slugify-golden.json. This test closes the loop: it asks the
 * consuming site's REAL Jekyll, the one that decides every `/blog/<slug>/`
 * address, whether the golden file is still true. A Jekyll upgrade that
 * changes slug rules fails here, on the consumer that took the upgrade,
 * instead of silently turning the admin's links and the required
 * cms-preview-url / console-clean checks into 404s (adamdaniel.ai#3857's
 * class of failure).
 *
 * CONSUMER mode only (SITE_ROOT set): that lane builds the site with the
 * site's own bundle, so Jekyll is guaranteed resolvable there and a failure to
 * load it is a real failure. The platform's self-CI has no Jekyll in its unit
 * lanes (by design), so it skips. One project only — the answer does not
 * depend on the browser.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

const GOLDEN_PATH = path.join(__dirname, "jekyll-slugify-golden.json");
const SITE_ROOT = process.env.SITE_ROOT;

const RUBY = `
require "jekyll"
require "json"
cases = JSON.parse(STDIN.read)
puts JSON.generate("version" => Jekyll::VERSION, "out" => cases.map { |s| Jekyll::Utils.slugify(s) })
`;

test("the site's own Jekyll agrees with jekyll-slugify-golden.json on every case", () => {
  test.skip(!SITE_ROOT, "platform self-CI: no Jekyll in the unit lanes; this runs on each consumer's e2e lane");
  test.skip(test.info().project.name !== "chromium-light", "browser-independent — runs on one project only");

  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
  const inputs = golden.cases.map(([input]) => input);
  const raw = execFileSync("bundle", ["exec", "ruby", "-Eutf-8", "-e", RUBY], {
    cwd: SITE_ROOT,
    input: JSON.stringify(inputs),
    env: { ...process.env, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
    encoding: "utf8",
    stdio: ["pipe", "pipe", "ignore"], // Jekyll warns on stderr for empty slugs
    timeout: 120_000,
  });
  const { version, out } = JSON.parse(raw.trim().split("\n").pop());
  const mismatches = inputs
    .map((input, i) => ({ input, golden: golden.cases[i][1], jekyll: out[i] }))
    .filter((m) => m.golden !== m.jekyll);
  expect(
    mismatches,
    `Jekyll ${version} (golden made with ${golden.jekyll_version}) disagrees — every slugify port is ` +
      "now wrong for these inputs. In cms-platform, regenerate the golden file (generate-slugify-golden.rb) " +
      "and fix the ports " +
      "until slugify-parity.test.js passes.",
  ).toEqual([]);
});
