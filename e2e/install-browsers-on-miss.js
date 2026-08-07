/*
 * Playwright globalSetup: install-on-miss browser self-heal (#1723 Cat 4).
 *
 * The drift guard (scripts/check-playwright-image-drift.js) PREVENTS a
 * @playwright/test bump from merging without the matching ci-runner base
 * image, so the prebaked browsers normally match the client. This is the
 * belt-and-suspenders runtime net for the residual cases that guard
 * can't see (a stale/partially-built image served from cache, a registry
 * hiccup): if the build Playwright expects for THIS @playwright/test
 * version is absent at launch time, install just the missing browser(s)
 * before the suite runs instead of dying with "Executable doesn't exist
 * at /ms-playwright/...".
 *
 * Cost: when the browsers are present (the normal path) this is three
 * `executablePath()` + `existsSync()` checks — sub-millisecond, no
 * network. It only shells out to `npx playwright install` for the
 * specific browser(s) actually missing, which is exactly the rare flake
 * we want to self-heal. Never throws (a failed install is logged and
 * left to surface as the original launch error) so it can't itself
 * become a new way for every run to go red.
 */
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const { chromium, firefox, webkit } = require("@playwright/test");

// Which engines this run actually needs. The e2e-tests workflow runs one job
// per Playwright project and installs ONLY that project's engine (see
// e2e/ci-matrix.js), so a blanket check here would report the other two as
// "missing" and re-download them — undoing the scoped install on every single
// job. `PW_PROJECT` is the workflow's per-job project name; without it (a full
// local run, or another reusable running the whole matrix) every engine is in
// play and all three are checked, exactly as before.
function neededEngines() {
  const project = (process.env.PW_PROJECT || "").trim();
  if (!project) return new Set(["chromium", "firefox", "webkit"]);
  try {
    return new Set([require("./ci-matrix").engineFor(project)]);
  } catch (e) {
    // An unknown project is the workflow's problem to report, not this
    // self-heal's — fall back to checking everything.
    console.warn(`[install-on-miss] ${e.message} — checking every engine instead.`);
    return new Set(["chromium", "firefox", "webkit"]);
  }
}

module.exports = async () => {
  const browsers = [
    ["chromium", chromium],
    ["firefox", firefox],
    ["webkit", webkit],
  ].filter(([name]) => neededEngines().has(name));
  const missing = [];
  for (const [name, type] of browsers) {
    let exe;
    try {
      exe = type.executablePath();
    } catch (_) {
      // executablePath() throws when the build isn't installed at all.
      missing.push(name);
      continue;
    }
    if (!exe || !fs.existsSync(exe)) missing.push(name);
  }
  if (missing.length === 0) return;

  console.warn(
    `[install-on-miss] Playwright browser build(s) missing for this @playwright/test version: ` +
      `${missing.join(", ")} — installing the lockfile-matched build before the suite ` +
      `(self-healing #1723 Cat 4). This should be rare; if it recurs, the ci-runner image ` +
      `base (PLAYWRIGHT_IMAGE_TAG) is drifting from package-lock.json.`,
  );
  try {
    // Browsers only (no --with-deps): the ci-runner image already has the
    // OS deps; installing the missing build into PLAYWRIGHT_BROWSERS_PATH
    // is enough to make `launch` resolve.
    execSync(`npx playwright install ${missing.join(" ")}`, { stdio: "inherit" });
  } catch (e) {
    console.warn(
      `[install-on-miss] 'npx playwright install ${missing.join(" ")}' failed (${e && e.message}); ` +
        `letting the original launch error surface.`,
    );
  }
};

// Exported for e2e/ci-matrix.test.js — the scoped-install contract is the one
// thing here worth locking (a blanket check would re-download the engines the
// per-project CI job skipped).
module.exports.neededEngines = neededEngines;
