// @lane: local — PURE-FS recurrence guard for the PLATFORM_META_SPECS registry
// (NO Jekyll build, NO browser). Runs in self-ci.yml's node-unit-lints lane.
//
// THE #16 SYSTEMIC FIX. A consumer's e2e lane runs the SHARED harness with
// CONSUMER=true (SITE_ROOT set), and playwright.config.js testIgnore's every
// name in PLATFORM_META_SPECS — the platform-internal specs that validate the
// platform's OWN machinery (its reusable workflow DEFINITIONS, scripts/,
// scaffold/, theme/ source internals, harness self-tests against the platform
// fixtures). Those specs read files a consumer's thin-caller/site tree does NOT
// ship, so when they're NOT registered they RUN and FAIL on the consumer
// (adamdaniel.ai v0.1.10 reconciliation surfaced exactly this: five unregistered
// meta-specs red-failed the consumer e2e lane).
//
// The platform's OWN self-CI runs e2e with TARGET=prod + --project=chromium-
// light, so it NEVER exercises the CONSUMER=true lane — a newly-added,
// unregistered platform-internal spec ships GREEN on the platform and only
// detonates on the next consumer. select-specs.js picks specs by DIFF, so the
// blast radius depends on the consumer PR's shape: a differently-shaped consumer
// PR selects a DIFFERENT unregistered meta-spec. The only durable fix is to make
// "I forgot to register a platform-internal spec" impossible to ship.
//
// This lint STATICALLY detects platform-internal specs and FAILS if any is NOT
// in PLATFORM_META_SPECS — mirroring base-collections-guard-registry.test.js's
// "no silent drift" gate. A new platform-internal spec left unregistered turns
// this RED in the platform's own self-CI, BEFORE it can break a consumer.
//
// ── What makes a spec PLATFORM-INTERNAL ──────────────────────────────────
// It validates the PLATFORM'S OWN machinery, not a consuming SITE's content/
// admin behavior. Concretely, its CODE (comments stripped) does at least one of:
//
//   SCRIPTS       reads/execs the platform `scripts/**` tree (a deploy/preflight
//                 artifact the platform runs; consumers don't ship scripts/).
//   SCAFFOLD      reads/runs the `scaffold/**` site generator.
//   WORKFLOWS-DEF reads the platform's OWN reusable workflow DEFINITIONS — via
//                 workflow-yaml-utils / readWorkflow(), or an fs path into
//                 ../.github/workflows or the examples/site/.github templates.
//   THEME-SRC     reads the `theme/**` SOURCE tree (admin JS / layouts/ gem
//                 internals) — NOT the gem-RENDERED `${SITE_ROOT}/_site/admin`.
//   PLATFORM-FIXTURE  is a harness self-test that drives the platform's OWN
//                 fixtures as a literal path (fixture-site / the singlepage
//                 fixture only the PLATFORM carries), not via SITE_ROOT.
//
// A genuine SITE spec — sitemap/tags/feeds/console-clean/cms-config/permalink/
// post-summary, the canary content invariants, the manual walkthroughs, the
// real publish-loop round-trips — resolves its root through SITE_ROOT and reads
// the CONSUMER's own built `_site/**` / content tree (or self-gates on
// site-capabilities). Those run on a consumer and MUST stay OUT of the registry.
// The detector keys off REAL source-tree reads (../scripts, ../scaffold,
// ../theme, ../.github/workflows, the platform fixtures), which a SITE_ROOT-
// rooted `_site/**` read never matches — so site specs are never flagged.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const E2E_DIR = __dirname;
const CONFIG = path.join(E2E_DIR, "playwright.config.js");

// Parse PLATFORM_META_SPECS out of playwright.config.js (its single source of
// truth) so this lint stays in lockstep without importing the config (which has
// env/webServer side effects). Same parser idiom as
// admin-spec-source-read-lint.test.js / base-collections-guard-registry.test.js.
function metaSpecs() {
  const src = fs.readFileSync(CONFIG, "utf8");
  const m = src.match(/PLATFORM_META_SPECS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) throw new Error("could not locate PLATFORM_META_SPECS in playwright.config.js");
  return new Set([...m[1].matchAll(/["'`]([^"'`]+\.(?:spec|test)\.js)["'`]/g)].map((x) => x[1]));
}

// Strip JS comments before scanning — a comment may legitimately MENTION
// scripts/ or theme/admin (explaining why we DON'T read them, naming the
// platform workflow in an error string, etc.). Block + line comments; the
// `[^:]` guard on `//` spares URL schemes like `https://`.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// ── The detector ─────────────────────────────────────────────────────────
// Return the list of platform-internal SIGNAL classes a spec's CODE carries
// (empty ⇒ the spec is not platform-internal). Operates on comment-stripped
// source so only REAL reads/execs count.
//
// IMPORTANT — path-name-agnostic. A spec may name its base path REPO_ROOT,
// E2E_DIR, __dirname, etc.; what matters is the literal SUBPATH it reads. So we
// match the `scripts/<x>` / `scaffold/<x>` / `theme/<x>` SUBPATH literal AND the
// `path.join/resolve(..., "scripts"|"scaffold"|"theme", ...)` segment form, no
// matter how the prefix variable is spelled. (cms-config-preview-delta.spec.js
// exposed this: it execs `path.join(REPO_ROOT, "scripts/patch-preview-config.sh")`
// — a `REPO_ROOT`-based prefix the original ../scripts-only matcher missed.)
function platformSignals(code) {
  const s = [];

  // SCRIPTS — reads/execs the platform scripts/ tree.
  if (
    /["'`][^"'`]*\bscripts\/[\w.-]+/.test(code) || // "<...>scripts/<file>" literal (e.g. REPO_ROOT + "scripts/x.sh")
    /\bscripts["'`]\s*[,)]/.test(code) || // path.join(..., "scripts") / path.resolve(..., "scripts")
    /["'`]\.\.\/scripts\//.test(code)
  ) {
    s.push("scripts");
  }

  // SCAFFOLD — reads/runs the scaffold/ site generator.
  if (
    /["'`][^"'`]*\bscaffold\/[\w.-]+/.test(code) ||
    /\bscaffold["'`]\s*[,)]/.test(code) ||
    /scaffold\/create-site/.test(code)
  ) {
    s.push("scaffold");
  }

  // WORKFLOWS-DEF — reads the platform's OWN reusable workflow definitions:
  // via the workflow-yaml-utils helper / readWorkflow(), or an fs path into
  // ../.github/workflows, or the examples/site/.github platform templates.
  if (
    /require\(["'`]\.\/workflow-yaml-utils["'`]\)/.test(code) ||
    /\breadWorkflow\s*\(/.test(code) ||
    /\.\.\/\.github\/workflows/.test(code) ||
    /\.github["'`]\s*,\s*["'`]workflows["'`]/.test(code) ||
    /["'`]examples["'`]\s*,\s*["'`]site["'`]/.test(code) ||
    /\bexamples\/site\/\.github/.test(code)
  ) {
    s.push("workflows-def");
  }

  // THEME-SRC — reads the theme/ SOURCE tree (NOT the rendered _site/admin).
  // `theme/admin`, `theme/<x>` literal, or path.join(..., "theme", ...) segment.
  if (
    /["'`][^"'`]*\btheme\/[\w.-]+/.test(code) ||
    /\btheme["'`]\s*,\s*["'`][\w.-]+["'`]/.test(code) ||
    /\btheme["'`]\s*,\s*["'`]admin/.test(code)
  ) {
    s.push("theme-src");
  }

  // PLATFORM-FIXTURE — harness self-test driving the platform's OWN fixtures as
  // a literal path. The singlepage fixture exists ONLY in the platform tree, and
  // a literal path.join(..., "fixture-site") (not via SITE_ROOT) is a platform
  // self-test root.
  if (
    /fixture-site-singlepage/.test(code) ||
    /["'`]fixture-site["'`]\s*\)/.test(code) ||
    /\bfixture-site["'`]\s*,/.test(code)
  ) {
    s.push("platform-fixture");
  }

  return s;
}

// Convenience boolean used by the gate + sabotage proof.
function isPlatformInternal(code) {
  return platformSignals(code).length > 0;
}

function allSpecFiles() {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.js") || f.endsWith(".test.js"))
    .sort();
}

test.describe("#16 PLATFORM_META_SPECS recurrence guard", () => {
  test("the meta-spec registry parsed from playwright.config.js", () => {
    expect(
      metaSpecs().size,
      "PLATFORM_META_SPECS must parse from playwright.config.js (single source of truth)",
    ).toBeGreaterThan(0);
  });

  // THE GATE. Every spec whose CODE reads the platform's OWN machinery
  // (scripts/, scaffold/, the reusable workflow DEFINITIONS, theme/ source, or
  // the platform fixtures) MUST be in PLATFORM_META_SPECS — else it RUNS on a
  // CONSUMER=true e2e lane (where that source doesn't exist) and red-fails. A
  // NEW unregistered platform-internal spec turns this RED in the platform's own
  // self-CI, before it can break a consumer.
  test("every platform-internal spec is registered in PLATFORM_META_SPECS", () => {
    const meta = metaSpecs();
    const offenders = [];
    for (const f of allSpecFiles()) {
      const code = stripComments(fs.readFileSync(path.join(E2E_DIR, f), "utf8"));
      const sig = platformSignals(code);
      if (sig.length && !meta.has(f)) {
        offenders.push(`${f} [${sig.join(", ")}]`);
      }
    }
    expect(
      offenders,
      `these specs read the PLATFORM'S OWN machinery (scripts/, scaffold/, the ` +
        `reusable workflow DEFINITIONS, theme/ source, or the platform fixtures) ` +
        `but are NOT in PLATFORM_META_SPECS — a CONSUMER=true e2e lane (where that ` +
        `source does not exist) would RUN and red-fail them. Add each to ` +
        `PLATFORM_META_SPECS in playwright.config.js. (If a spec only LOOKS internal ` +
        `because it reads the consumer's own \${SITE_ROOT}/_site/** tree, it must read ` +
        `via SITE_ROOT — not a ../scripts, ../scaffold, ../theme, or ../.github/workflows ` +
        `source path — so the detector won't flag it.)`,
    ).toEqual([]);
  });

  // The registry must not rot in the other direction either: a SITE spec wrongly
  // parked in PLATFORM_META_SPECS would be testIgnore'd on consumers and lose
  // its coverage there. So every NAME the registry lists must (a) exist and
  // (b) be a .spec.js / .test.js file. (We do NOT assert every registered spec
  // is detector-positive: some platform-meta specs are internal for reasons the
  // static detector can't see — e.g. they assert admin-JS DOM augmentation or
  // synthetic builds without an fs source-tree read. Those are legitimately
  // registered by hand; the detector is a FLOOR, not a ceiling.)
  test("every registered meta-spec name exists on disk", () => {
    const present = new Set(allSpecFiles());
    const missing = [...metaSpecs()].filter((n) => !present.has(n));
    expect(
      missing,
      `PLATFORM_META_SPECS lists names with no matching e2e/ file — remove the stale ` +
        `entries (or restore the files): ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // SABOTAGE PROOF — the detector actually fires. A synthetic platform-internal
  // spec body (reads ../scripts) must be classified internal; a synthetic SITE
  // body (reads ${SITE_ROOT}/_site) must NOT. If the detector ever regresses to
  // a no-op (always-empty signals), the gate above silently stops protecting and
  // this catches it.
  test("detector classifies a synthetic platform-internal body internal, a SITE body not", () => {
    const internalBody = `
      const path = require("node:path");
      const SCRIPT = path.join(__dirname, "..", "scripts", "preflight-oauth.js");
      const { spawnSync } = require("node:child_process");
    `;
    const siteBody = `
      const path = require("node:path");
      const SITE_ROOT = process.env.SITE_ROOT || path.join(__dirname, "..");
      const CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");
    `;
    expect(
      isPlatformInternal(stripComments(internalBody)),
      "a spec that reads ../scripts MUST be classified platform-internal",
    ).toBe(true);
    expect(
      isPlatformInternal(stripComments(siteBody)),
      "a spec that reads ${SITE_ROOT}/_site MUST NOT be classified platform-internal (it's a SITE spec)",
    ).toBe(false);
  });
});

// Exported for any sibling/diagnostic that wants the same classification.
module.exports = { platformSignals, isPlatformInternal, stripComments, metaSpecs };
