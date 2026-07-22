// @lane: local — pure-fs invariant: the scaffolder + the platform's own e2e
// fixtures seed the preview-media probe sentinel (issue #84).
//
// `e2e/preview-media-resolves.spec.js` hardcodes
// `PROBE_PATH = /assets/images/uploads/e2e-preview-media-probe.png` — the
// `preview-media` gate fetches that committed image on the deployed preview to
// prove the flat `media_folder` resolves. Without it, a fresh consumer only
// "passes" preview-media by never tripping the gate's media-salient-change
// detector, then 404s the first time a media-salient change (e.g. a
// `_config.yml` edit) DOES trip it — this bit jodidaniel.com on the v0.1.30
// bump (fixed by hand, jodidaniel#52). This lint locks the fix so it can't
// regress: the scaffolder emits the sentinel into every new site, and both
// platform e2e fixtures (the full `fixture-site` the issue names, plus
// `fixture-site-singlepage` — jodidaniel's shape needed it in prod too) carry
// it.
//
// Pure delivery-artifact assertion (file existence + byte-equality) — not a
// code-shape lint, so no AST is needed here (mirrors scaffold-preview-and-
// 404.test.js / scaffold-seeds-neutral-logo.test.js).
const { test, expect } = require("./base");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCAFFOLDER = path.join(REPO_ROOT, "scaffold", "create-site.js");
const CANONICAL_PNG = path.join(REPO_ROOT, "e2e", "fixtures", "tiny-pixel.png");
const PROBE_REL = path.join("assets", "images", "uploads", "e2e-preview-media-probe.png");

test.describe("scaffolder + fixtures seed the preview-media probe sentinel (#84)", () => {
  let target;
  let canonicalBytes;

  test.beforeAll(() => {
    canonicalBytes = fs.readFileSync(CANONICAL_PNG);
    target = fs.mkdtempSync(path.join(os.tmpdir(), "cms84-scaffold-"));
    // --platform-ref pins the version so this test never hits the network.
    execFileSync(
      "node",
      [SCAFFOLDER, target, "--yes", "--domain", "test.local", "--repo", "test", "--owner", "test-owner", "--platform-ref", "v0.1.52"],
      { stdio: "pipe" },
    );
  });

  test.afterAll(() => {
    if (target) fs.rmSync(target, { recursive: true, force: true });
  });

  test("the canonical fixture PNG is the expected 69-byte sentinel", () => {
    // Guards the OTHER assertions below against a silently-edited fixture: if
    // this ever fails, every byte-equal check downstream would be comparing
    // against the wrong bytes without saying so.
    expect(canonicalBytes.length, "e2e/fixtures/tiny-pixel.png").toBe(69);
  });

  test("scaffold output carries the sentinel, byte-equal to e2e/fixtures/tiny-pixel.png", () => {
    const probePath = path.join(target, PROBE_REL);
    expect(fs.existsSync(probePath), `scaffolder must seed ${probePath}`).toBe(true);
    expect(fs.readFileSync(probePath).equals(canonicalBytes), `${probePath} bytes`).toBe(true);
  });

  test("e2e/fixture-site carries the sentinel, byte-equal to e2e/fixtures/tiny-pixel.png", () => {
    const probePath = path.join(REPO_ROOT, "e2e", "fixture-site", PROBE_REL);
    expect(fs.existsSync(probePath), `fixture-site must carry ${probePath}`).toBe(true);
    expect(fs.readFileSync(probePath).equals(canonicalBytes), `${probePath} bytes`).toBe(true);
  });

  // Beyond the issue's literal ask (fixture-site only): jodidaniel.com is a
  // single-page consumer (fixture-site-singlepage's shape) and it needed this
  // sentinel in prod too — the preview-media gate is workflow-level and
  // collection-agnostic, so it applies to a single-page site exactly the same.
  test("e2e/fixture-site-singlepage carries the sentinel, byte-equal to e2e/fixtures/tiny-pixel.png", () => {
    const probePath = path.join(REPO_ROOT, "e2e", "fixture-site-singlepage", PROBE_REL);
    expect(fs.existsSync(probePath), `fixture-site-singlepage must carry ${probePath}`).toBe(true);
    expect(fs.readFileSync(probePath).equals(canonicalBytes), `${probePath} bytes`).toBe(true);
  });
});
