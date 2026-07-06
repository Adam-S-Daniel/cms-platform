// @lane: local — pure-fs invariant: the scaffolder resolves the platform
// release to pin a new site to, instead of stamping a hardcoded constant.
//
// Why: scaffold/create-site.js used to hardcode PLATFORM_VERSION and stamp it
// into every new site's workflow pins, platform.lock, and README — drifting
// stale the moment a platform release shipped. resolvePlatformVersion() now
// resolves the latest release dynamically at scaffold time (via `gh`, then the
// GitHub REST API, then a documented fallback constant), with an explicit
// --platform-ref flag / CMS_PLATFORM_REF env override for hermetic tests and
// pinned scaffolds. This locks the override precedence end-to-end.
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");

test.describe("scaffolder resolves the platform release to pin a new site to (#1852-ish: PLATFORM_VERSION staleness)", () => {
  test.describe("--platform-ref flag", () => {
    let target;
    test.beforeAll(() => {
      target = fs.mkdtempSync(path.join(os.tmpdir(), "cms-platform-ref-scaffold-"));
      execFileSync(
        "node",
        [
          SCAFFOLDER,
          target,
          "--yes",
          "--domain",
          "test.local",
          "--repo",
          "test",
          "--owner",
          "test-owner",
          "--platform-ref",
          "v9.9.9",
        ],
        { stdio: "pipe" },
      );
    });
    test.afterAll(() => {
      if (target) fs.rmSync(target, { recursive: true, force: true });
    });

    test("platform.lock pins the explicit --platform-ref", () => {
      const lock = fs.readFileSync(path.join(target, "platform.lock"), "utf8");
      expect(lock).toMatch(/platform_ref: v9\.9\.9/);
    });

    test("README.md references the explicit --platform-ref", () => {
      const readme = fs.readFileSync(path.join(target, "README.md"), "utf8");
      expect(readme).toMatch(/@v9\.9\.9/);
    });

    test("at least one seeded workflow pins the explicit --platform-ref", () => {
      const workflowsDir = path.join(target, ".github/workflows");
      const files = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
      expect(files.length, "scaffolder must seed at least one workflow file").toBeGreaterThan(0);
      const pinned = files.some((f) => {
        const body = fs.readFileSync(path.join(workflowsDir, f), "utf8");
        return /uses:.*@v9\.9\.9/.test(body);
      });
      expect(pinned, "at least one seeded workflow must pin @v9.9.9").toBe(true);
    });
  });

  test.describe("CMS_PLATFORM_REF env var", () => {
    let target;
    test.beforeAll(() => {
      target = fs.mkdtempSync(path.join(os.tmpdir(), "cms-platform-ref-env-scaffold-"));
      execFileSync(
        "node",
        [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner"],
        { stdio: "pipe", env: { ...process.env, CMS_PLATFORM_REF: "v8.8.8" } },
      );
    });
    test.afterAll(() => {
      if (target) fs.rmSync(target, { recursive: true, force: true });
    });

    test("platform.lock pins CMS_PLATFORM_REF", () => {
      const lock = fs.readFileSync(path.join(target, "platform.lock"), "utf8");
      expect(lock).toMatch(/platform_ref: v8\.8\.8/);
    });

    test("README.md references CMS_PLATFORM_REF", () => {
      const readme = fs.readFileSync(path.join(target, "README.md"), "utf8");
      expect(readme).toMatch(/@v8\.8\.8/);
    });

    test("at least one seeded workflow pins CMS_PLATFORM_REF", () => {
      const workflowsDir = path.join(target, ".github/workflows");
      const files = fs.readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f));
      expect(files.length, "scaffolder must seed at least one workflow file").toBeGreaterThan(0);
      const pinned = files.some((f) => {
        const body = fs.readFileSync(path.join(workflowsDir, f), "utf8");
        return /uses:.*@v8\.8\.8/.test(body);
      });
      expect(pinned, "at least one seeded workflow must pin @v8.8.8").toBe(true);
    });
  });

  test.describe("resolvePlatformVersion() unit behavior — no subprocess, no network", () => {
    test("explicit CMS_PLATFORM_REF override wins without touching gh/network", async () => {
      const { resolvePlatformVersion } = require("../scaffold/create-site.js");
      const had = Object.prototype.hasOwnProperty.call(process.env, "CMS_PLATFORM_REF");
      const original = process.env.CMS_PLATFORM_REF;
      process.env.CMS_PLATFORM_REF = "v7.7.7";
      try {
        const resolved = await resolvePlatformVersion({});
        expect(resolved).toBe("v7.7.7");
      } finally {
        if (had) process.env.CMS_PLATFORM_REF = original;
        else delete process.env.CMS_PLATFORM_REF;
      }
    });

    test("the fallback PLATFORM_VERSION constant is a well-formed vX.Y.Z tag", () => {
      const { PLATFORM_VERSION } = require("../scaffold/create-site.js");
      expect(PLATFORM_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
    });
  });
});
