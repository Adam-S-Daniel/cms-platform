// @lane: local — PURE-FS single-version guard for the SCAFFOLD TEMPLATE's
// platform pins (NO Jekyll build, NO browser, NO network). Runs in self-ci.yml's
// node-unit-lints lane (picked up automatically — that lane builds its spec list
// by EXCLUSION, so only a build-dependent lint ever needs registering).
//
// ── WHAT ROTTED ───────────────────────────────────────────────────────────
// `examples/site/.github/workflows` is the template tree: 32 thin callers, each
// naming the platform reusable it invokes. Between them they carry 54 platform
// version references — 32 `uses: Adam-S-Daniel/cms-platform/...@vX.Y.Z` and 22
// `with: platform_ref: vX.Y.Z`. Measured on the pre-fix tree, those 54 refs held
// NINE DISTINCT versions (v0.1.1 ×40, v0.1.59 ×2, v0.1.52, v0.1.46 ×2, v0.1.0,
// v0.1.6 ×2, v0.1.8 ×2, v0.1.3 ×2, v0.1.58 ×2) — up to 83 releases stale.
//
// ── WHY NOTHING CAUGHT IT ─────────────────────────────────────────────────
// Not for lack of a pin-consistency gate. `check-platform-pin-consistency.js`
// NORMALISES `@vX.Y.Z` → `@vREF` before comparing, precisely so it can compare
// pin SHAPES across a repo; that makes it structurally BLIND to the template's
// pin VALUES. Both real consumers passed at v0.1.84 against the fully-rotted
// template. Nor does the scaffolder itself surface it: `create-site.js`'s `sub()`
// transform rewrites every `platform_ref:` and every `@vX.Y.Z` on the way out, so
// a SCAFFOLDED site gets ONE version and the nine stale ones never reach it.
//
// So the rot is real but LATENT, and its victim is a human: `docs/SYNC.md` tells
// a maintainer to re-copy thin callers FROM `examples/site` when adopting a new
// workflow. Hand-copy a caller off this tree and you import a v0.1.1 pin into a
// live consumer — which the consumer's own pin-consistency gate WILL then red,
// far from the cause. This lint moves that failure to the platform PR that let
// the template drift.
//
// ── THE CONTRACT ──────────────────────────────────────────────────────────
// Every platform version reference reachable from a scaffolded site's inputs
// agrees on ONE version, and that version is the platform's CANONICAL one:
//
//   1. `plugin.json` and `.claude-plugin/plugin.json` versions agree.
//   2. Every template `uses: <platform>@ref` equals `v<version>`.
//   3. Every template `with: platform_ref:` equals `v<version>`.
//   4. `scaffold/create-site.js`'s `PLATFORM_VERSION` fallback equals
//      `v<version>` — the value an OFFLINE scaffold stamps into every pin.
//
// ── WHY plugin.json IS THE CANONICAL SOURCE ───────────────────────────────
// It is already locked at both ends: to its twin manifest by
// plugin-manifests.test.js, and to the git tag by release.yml (which REFUSES to
// cut a tag disagreeing with the manifests). AGENTS.md's "Current release:" line
// is unlocked PROSE — do not anchor to it.
//
// ── WHY THIS CANNOT DEADLOCK A RELEASE ────────────────────────────────────
// It compares IN-REPO VALUES ONLY and never resolves a ref, so a release PR may
// legitimately pin a tag that does not exist yet: bump the manifests, the
// template and the scaffolder together in that one PR and this lint goes green
// BEFORE the tag is cut (verified against an unpublished version). The
// deadlocking alternative — asserting against the LATEST PUBLISHED release — is
// deliberately rejected: vNEXT would be unpublishable (the guard would demand a
// tag that only the merge can create) and the lint would take a network
// dependency and stop being deterministic.
//
// ── NON-DEGRADATION ───────────────────────────────────────────────────────
// A lint that silently finds NOTHING passes vacuously — the failure mode
// `--require-canonical` was added to check-platform-pin-consistency.js to close.
// So this asserts a structural FLOOR too: every template workflow is a thin
// caller, so each file must yield at least one platform `uses:` ref. If a parser
// or layout change ever stops the walk from seeing refs, this reds instead of
// going quietly green.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_WORKFLOWS = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const ROOT_MANIFEST = path.join(REPO_ROOT, "plugin.json");
const CLAUDE_MANIFEST = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";

const rel = (p) => path.relative(REPO_ROOT, p);

function readVersion(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return String(doc.version || "");
}

// Key-aware walk of the PARSED YAML tree (the `yaml` lib, via the shared
// workflow-yaml-utils helper — anchors and aliases already resolved). Structure,
// not source text: a regex over the raw YAML would false-match version strings
// in comments and could not tell a `uses:` value from a `platform_ref:` one, and
// per AGENTS.md ("AST always, never regex, for code-shape lints") a lint that
// reasons about which KEY a value belongs to has to parse.
function collectRefs(doc) {
  const out = [];
  (function walk(node) {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "uses" && typeof value === "string" && value.startsWith(PLATFORM_REPO)) {
        const at = value.lastIndexOf("@");
        // A platform `uses:` with no `@ref` at all is itself a defect: it would
        // float to the default branch. Record it so it fails the value compare.
        out.push({ kind: "uses", ref: at === -1 ? "(no @ref)" : value.slice(at + 1), raw: value });
      }
      if (key === "platform_ref" && typeof value === "string") {
        out.push({ kind: "platform_ref", ref: value, raw: `platform_ref: ${value}` });
      }
      walk(value);
    }
  })(doc);
  return out;
}

function templateFiles() {
  return fs
    .readdirSync(TEMPLATE_WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

test.describe("examples/site template pins the CANONICAL platform version", () => {
  test("the two plugin manifests agree on a well-formed version", () => {
    const root = readVersion(ROOT_MANIFEST);
    const claude = readVersion(CLAUDE_MANIFEST);

    expect(
      root,
      `${rel(ROOT_MANIFEST)} version "${root}" is not a bare X.Y.Z — this lint derives the ` +
        `canonical platform ref from it, so an unparseable value would silently weaken every ` +
        `assertion below.`,
    ).toMatch(/^\d+\.\d+\.\d+$/);

    expect(
      claude,
      `the plugin manifests disagree: ${rel(ROOT_MANIFEST)} has "${root}", ` +
        `${rel(CLAUDE_MANIFEST)} has "${claude}". They describe ONE plugin; bump them together ` +
        `(plugin-manifests.test.js owns this invariant — this is its precondition).`,
    ).toBe(root);
  });

  test("every template workflow yields at least one platform uses: ref (no vacuous pass)", () => {
    const files = templateFiles();

    expect(
      files.length,
      `no workflow YAML under ${rel(TEMPLATE_WORKFLOWS)} — the template tree is the thing this ` +
        `lint guards; an empty read means it is asserting nothing.`,
    ).toBeGreaterThan(0);

    const barren = files.filter(
      (f) =>
        !collectRefs(parseYaml(fs.readFileSync(path.join(TEMPLATE_WORKFLOWS, f), "utf8"))).some(
          (r) => r.kind === "uses",
        ),
    );

    expect(
      barren,
      `these template workflows yielded NO platform 'uses:' ref: ${barren.join(", ")}. Every ` +
        `caller in this tree is a thin wrapper around a platform reusable, so zero refs means ` +
        `the walk stopped seeing them (a parser or layout change) — not that the pins are fine. ` +
        `Fix the walk rather than the expectation.`,
    ).toEqual([]);
  });

  test("every template uses:@ref and platform_ref: equals the canonical version", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const offenders = [];
    let checked = 0;

    for (const file of templateFiles()) {
      const text = fs.readFileSync(path.join(TEMPLATE_WORKFLOWS, file), "utf8");
      for (const found of collectRefs(parseYaml(text))) {
        checked++;
        if (found.ref !== canonical) offenders.push(`${file}: ${found.raw}`);
      }
    }

    expect(
      checked,
      `walked ${rel(TEMPLATE_WORKFLOWS)} and found ZERO platform version references — this lint ` +
        `would pass vacuously. Investigate the walk before trusting a green run.`,
    ).toBeGreaterThan(0);

    expect(
      offenders,
      `${offenders.length} of ${checked} platform version reference(s) in ` +
        `${rel(TEMPLATE_WORKFLOWS)} disagree with the canonical ${canonical} (from ` +
        `${rel(ROOT_MANIFEST)}):\n  ${offenders.join("\n  ")}\n\n` +
        `Bring every 'uses: ${PLATFORM_REPO}/...@ref' and every 'with: platform_ref:' in the ` +
        `template to ${canonical}. A maintainer hand-copies callers OUT of this tree ` +
        `(docs/SYNC.md), so a stale pin here becomes a stale pin in a live consumer. If you are ` +
        `cutting a release, bump the manifests, this template and scaffold/create-site.js's ` +
        `PLATFORM_VERSION in the SAME PR — this lint never resolves the tag, so it goes green ` +
        `before the tag exists.`,
    ).toEqual([]);
  });

  test("the scaffolder's offline PLATFORM_VERSION fallback is the canonical version", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const { PLATFORM_VERSION } = require("../scaffold/create-site.js");

    expect(
      PLATFORM_VERSION,
      `scaffold/create-site.js PLATFORM_VERSION is "${PLATFORM_VERSION}", canonical is ` +
        `"${canonical}". This constant is what an OFFLINE scaffold (no gh, no network) stamps ` +
        `into a new site's platform.lock, Gemfile tag: and every workflow pin — a stale value ` +
        `silently births a site pinned releases back. Bump it with the manifests. ` +
        `(scaffold-platform-version.test.js guards its SHAPE; this guards its VALUE.)`,
    ).toBe(canonical);
  });
});
