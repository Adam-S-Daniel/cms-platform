// @lane: local — execs scripts/patch-preview-config.sh against a tmp checkout; pure-fs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test, expect } = require("./base");

// Unit-ish test for scripts/patch-preview-config.sh: copies the real
// admin/config.yml into a temp dir, runs the script, and asserts the
// patched output has the three fields the preview deploy depends on.
// Catches regressions when admin/config.yml's layout changes.

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "scripts/patch-preview-config.sh");
const CONFIG_SOURCE = path.join(REPO_ROOT, "admin/config.yml");

const PR_NUMBER = "9999";
const BRANCH = "feature/some-branch-name";
const HOST = `preview-pr${PR_NUMBER}.adamdaniel.ai`;

test.describe("Preview deploy: patch-preview-config.sh", () => {
  let patched;
  let preImage;

  test.beforeAll(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "preview-config-"));
    const tmpConfig = path.join(tmpDir, "config.yml");
    fs.copyFileSync(CONFIG_SOURCE, tmpConfig);
    preImage = fs.readFileSync(tmpConfig, "utf8");
    execFileSync(SCRIPT, [tmpConfig, PR_NUMBER, BRANCH, HOST], {
      stdio: "pipe",
    });
    patched = fs.readFileSync(tmpConfig, "utf8");
  });

  test("site_url is the full preview subdomain", () => {
    expect(patched).toMatch(new RegExp(`^site_url: https://${HOST.replace(/\./g, "\\.")}$`, "m"));
  });

  test("display_url matches site_url for the Open Production Site button", () => {
    expect(patched).toMatch(
      new RegExp(`^display_url: https://${HOST.replace(/\./g, "\\.")}$`, "m"),
    );
  });

  test("backend.branch points at the PR head ref, not main", () => {
    expect(patched).toMatch(/^ {2}branch: feature\/some-branch-name$/m);
  });

  test("preview_path values are left untouched — same paths as prod", () => {
    // Each PR serves from its own subdomain root, so blog/project/page
    // URLs are identical to prod. The patch must not rewrite preview_path.
    const prePreviewPaths = [...preImage.matchAll(/preview_path:\s*"?([^"\s]+)/g)].map((m) => m[1]);
    const postPreviewPaths = [...patched.matchAll(/preview_path:\s*"?([^"\s]+)/g)].map((m) => m[1]);
    expect(postPreviewPaths).toEqual(prePreviewPaths);
  });
});
