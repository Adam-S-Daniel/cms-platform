// @lane: local — pure-fs lint of CloudWatch RUM wiring; no AWS, no network
const { test, expect } = require("./base");
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Build-output assertions for the CloudWatch RUM analytics include. Runs
// `jekyll build` to throwaway destinations under three conditions and
// inspects the resulting index.html. Single-project: the build cost would
// otherwise multiply by every Playwright project.

const REPO_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "rum-test-"));
const PROD_WITH_ID_DEST = path.join(TMP, "prod-with-id");
const PROD_NO_ID_DEST = path.join(TMP, "prod-no-id");
const NONPROD_DEST = path.join(TMP, "nonprod");
const OVERRIDE_CONFIG = path.join(TMP, "config-override.yml");
const EMPTY_OVERRIDE_CONFIG = path.join(TMP, "config-empty-override.yml");
const FAKE_APP_MONITOR_ID = "11111111-2222-3333-4444-555555555555";
const FAKE_IDENTITY_POOL = "us-east-1:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function runBuild({ env, configOverride, destination }) {
  const configs = ["_config.yml"];
  if (configOverride) configs.push(configOverride);
  const cmd = [
    "bundle exec jekyll build --quiet",
    `--config ${configs.join(",")}`,
    `--destination ${destination}`,
  ].join(" ");
  execSync(cmd, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readIndex(destination) {
  return fs.readFileSync(path.join(destination, "index.html"), "utf8");
}

test.describe("CloudWatch RUM include", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    if (test.info().project.name !== "chromium-desktop-1080") {
      test.skip(true, "build-output assertion only needs to run once per invocation");
    }
  });

  test.beforeAll(() => {
    if (test.info().project.name !== "chromium-desktop-1080") return;
    fs.writeFileSync(
      OVERRIDE_CONFIG,
      [
        "analytics:",
        "  cloudwatch_rum:",
        `    app_monitor_id: "${FAKE_APP_MONITOR_ID}"`,
        `    identity_pool_id: "${FAKE_IDENTITY_POOL}"`,
        '    region: "us-east-1"',
        "",
      ].join("\n"),
    );
    // Force-empty the IDs for the "no ID" build. Without this, the
    // build inherits whatever `_config.yml` ships on this branch — and
    // once the real production IDs land in `_config.yml` (so the JS
    // emits on adamdaniel.ai), this test's "silent when empty"
    // assertion sees the real IDs and fails. Overriding to empty
    // keeps the test independent of the main config's runtime values.
    fs.writeFileSync(
      EMPTY_OVERRIDE_CONFIG,
      [
        "analytics:",
        "  cloudwatch_rum:",
        '    app_monitor_id: ""',
        '    identity_pool_id: ""',
        '    region: "us-east-1"',
        "",
      ].join("\n"),
    );

    runBuild({
      env: { JEKYLL_ENV: "production" },
      configOverride: OVERRIDE_CONFIG,
      destination: PROD_WITH_ID_DEST,
    });
    runBuild({
      env: { JEKYLL_ENV: "production" },
      configOverride: EMPTY_OVERRIDE_CONFIG,
      destination: PROD_NO_ID_DEST,
    });
    runBuild({
      env: {},
      configOverride: OVERRIDE_CONFIG,
      destination: NONPROD_DEST,
    });
  });

  test("emits snippet when JEKYLL_ENV=production AND app_monitor_id is set", () => {
    const html = readIndex(PROD_WITH_ID_DEST);
    expect(html).toContain("AwsRumClient");
    expect(html).toContain(FAKE_APP_MONITOR_ID);
    expect(html).toContain(FAKE_IDENTITY_POOL);
    expect(html).toContain("client.rum.us-east-1.amazonaws.com");
  });

  test("snippet skips RUM init for automated browsers (navigator.webdriver)", () => {
    // The gate is a runtime check, but we lock the source-level
    // intent here so a future edit can't silently strip it. Catches
    // GitHub Actions Playwright traffic that would otherwise pollute
    // real-user metrics.
    const html = readIndex(PROD_WITH_ID_DEST);
    expect(html).toContain("navigator.webdriver");
  });

  test("snippet honors per-device opt-out via localStorage + ?rum=off trigger", () => {
    // Same source-level lock for the household-device opt-out path:
    // visiting `?rum=off` once persists `rum-opt-out=1` in
    // localStorage; the gate skips RUM init on every subsequent load
    // until the user clears site data (or visits `?rum=on`).
    const html = readIndex(PROD_WITH_ID_DEST);
    expect(html).toContain("rum-opt-out");
    expect(html).toMatch(/qs\.get\(["']rum["']\)\s*===\s*["']off["']/);
    expect(html).toMatch(/qs\.get\(["']rum["']\)\s*===\s*["']on["']/);
  });

  test("silent when JEKYLL_ENV=production but app_monitor_id is empty", () => {
    const html = readIndex(PROD_NO_ID_DEST);
    expect(html).not.toContain("AwsRumClient");
    expect(html).not.toContain("client.rum.");
  });

  test("silent when app_monitor_id is set but JEKYLL_ENV is not production", () => {
    const html = readIndex(NONPROD_DEST);
    expect(html).not.toContain("AwsRumClient");
    expect(html).not.toContain(FAKE_APP_MONITOR_ID);
  });
});
