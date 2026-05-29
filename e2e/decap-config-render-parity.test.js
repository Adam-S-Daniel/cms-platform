// @lane: local — pure-Node lint: the two Decap-config render paths must stay in lockstep.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// The platform renders the live Decap admin config + injects the window.CMS_*
// identity globals from TWO implementations that MUST agree — otherwise a
// gem-built site and a deploy-script-built site diverge (e.g. one gets
// CMS_SITE_TITLE / reviews-dashboard identity, the other a placeholder; that
// exact drift is why this lint exists):
//   - scripts/render-decap-config.rb                       (deploy-time CLI / post-build step)
//   - theme/lib/cms-platform-theme/decap_config_hook.rb    (Jekyll :post_write hook, gem path)
const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "render-decap-config.rb");
const HOOK = path.join(ROOT, "theme", "lib", "cms-platform-theme", "decap_config_hook.rb");

// The window.CMS_* keys assigned in the file's injected <script> string
// (only real assignments — `window.CMS_X=` — not the prose comments or the
// `"CMS_X" =>` token map).
function injectedGlobals(src) {
  return new Set([...src.matchAll(/window\.CMS_([A-Z0-9_]+)\s*=/g)].map((m) => m[1]));
}
const injectsIndex = (src) => /Dir\.glob\([^\n]*index\*\.html/.test(src);
const injectsReviews = (src) => /Dir\.glob\([^\n]*reviews[^\n]*\*\.html/.test(src);

test.describe("Decap-config render parity (deploy script vs theme-gem hook)", () => {
  const scriptSrc = fs.readFileSync(SCRIPT, "utf8");
  const hookSrc = fs.readFileSync(HOOK, "utf8");

  test("both inject the SAME set of window.CMS_* globals", () => {
    const s = injectedGlobals(scriptSrc);
    const h = injectedGlobals(hookSrc);
    expect(s.size, "render-decap-config.rb should inject window.CMS_* globals").toBeGreaterThan(0);
    expect(
      [...h].sort(),
      "decap_config_hook.rb must inject the SAME window.CMS_* keys as render-decap-config.rb (update both)",
    ).toEqual([...s].sort());
  });

  test("both inject into the Decap index shells AND the review dashboards", () => {
    expect(
      injectsIndex(scriptSrc) && injectsReviews(scriptSrc),
      "render-decap-config.rb must glob index*.html + reviews/*.html",
    ).toBe(true);
    expect(
      injectsIndex(hookSrc) && injectsReviews(hookSrc),
      "decap_config_hook.rb must glob index*.html + reviews/*.html",
    ).toBe(true);
  });
});
