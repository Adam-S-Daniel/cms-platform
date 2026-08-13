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
const { parse, calleeName, calleeTail, stringValue } = require("./spec-ast");

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

// ── #244 false-positive carve-out: SITE_ROOT-rooted workflows-dir reads ────
//
// THE INCIDENT. e2e/dependabot-theme-gem-ignored.test.js is a deliberately
// CONSUMER-ONLY spec (never registered in PLATFORM_META_SPECS — see its own
// header comment) whose whole reason to exist is running on a real
// consumer's e2e lane against that consumer's OWN `.github/dependabot.yml`.
// For cms-platform#244 it gained a second read, `path.join(process.env.
// SITE_ROOT, ".github", "workflows")`, so it can check the consumer's
// Dependabot ignore actually covers the cms-platform `uses:` refs that
// consumer really pins — the CONSUMER'S OWN workflow tree, not the
// platform's. But the plain `workflows-def` regex
// (`/\.github["'`]\s*,\s*["'`]workflows["'`]/`) fires on that string shape
// regardless of what it's rooted at, so it false-flagged the spec as
// platform-internal.
//
// WHY "just register the spec" IS THE WRONG FIX. `playwright.config.js`
// `testIgnore`s every name in PLATFORM_META_SPECS on every CONSUMER e2e
// lane. Registering this spec would silently VOID the #244 guard on the
// exact repos it exists to protect — the registry itself would ship a
// regression while looking green.
//
// WHY THIS MUST BE AST, NOT REGEX. Whether a `path.join`/`path.resolve` call
// is "rooted at SITE_ROOT" is a question about which ARGUMENTS belong to
// which CALL — a regex sees "SITE_ROOT" and ".github"/"workflows" as tokens
// floating independently in the file, with no notion of which call (if any)
// each belongs to, so it cannot distinguish `path.join(process.env.
// SITE_ROOT, ".github", "workflows")` from `path.join(__dirname, "..",
// ".github", "workflows")` followed, elsewhere in the file, by an unrelated
// `SITE_ROOT` reference. Per the repo's "AST always, never regex, for
// code-shape lints" rule (AGENTS.md), this has to parse.
//
// Parses the RAW, un-comment-stripped source. acorn already discards
// comments correctly as part of real JS parsing — that's the whole point of
// using an AST here — and `stripComments()` is a lexical regex pass that can
// mangle a string literal containing `//` (e.g. a URL), so its output must
// never be fed back into a parser.
function walkAst(node, fn) {
  if (!node || typeof node.type !== "string") return;
  fn(node);
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) value.forEach((child) => walkAst(child, fn));
    else if (value && typeof value.type === "string") walkAst(value, fn);
  }
}

// Does `node`'s subtree contain an Identifier literally named `name`?
// Matches both `process.env.SITE_ROOT` (a MemberExpression whose
// non-computed `.property` IS the Identifier `SITE_ROOT`) and a local
// `const SITE_ROOT = ...` passed straight in (the argument itself is the
// Identifier).
function subtreeHasIdentifierNamed(node, name) {
  let found = false;
  walkAst(node, (n) => {
    if (!found && n.type === "Identifier" && n.name === name) found = true;
  });
  return found;
}

// True only when the source contains AT LEAST ONE "workflows-dir join" — a
// `path.join`/`path.resolve` call whose statically-resolvable string
// arguments include BOTH ".github" and "workflows" — AND every such join is
// rooted at SITE_ROOT. False (never suppressing anything) when there are
// none, or the source fails to parse, so every spec that doesn't touch this
// carve-out at all keeps a byte-identical classification to before it
// existed.
function allWorkflowsDirJoinsAreSiteRootRooted(rawSrc) {
  let ast;
  try {
    ast = parse(rawSrc);
  } catch {
    return false; // unparseable — don't suppress; the plain regex still decides.
  }

  let sawWorkflowsDirJoin = false;
  let allRooted = true;

  walkAst(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const tail = calleeTail(calleeName(node.callee));
    if (tail !== "join" && tail !== "resolve") return;

    const args = node.arguments || [];
    const argStrings = args.map((a) => stringValue(a)).filter((v) => v != null);
    const isWorkflowsDirJoin = argStrings.includes(".github") && argStrings.includes("workflows");
    if (!isWorkflowsDirJoin) return;

    sawWorkflowsDirJoin = true;
    const rooted = args.some((a) => subtreeHasIdentifierNamed(a, "SITE_ROOT"));
    if (!rooted) allRooted = false;
  });

  return sawWorkflowsDirJoin && allRooted;
}

// ── The detector ─────────────────────────────────────────────────────────
// Return the list of platform-internal SIGNAL classes a spec's CODE carries
// (empty ⇒ the spec is not platform-internal). Operates on comment-stripped
// source so only REAL reads/execs count; `rawSrc` (default: `code`, for
// backward compatibility with any other caller of this exported function) is
// the ORIGINAL, un-comment-stripped source, needed only by the SITE_ROOT
// carve-out above, which must feed a real parser.
//
// IMPORTANT — path-name-agnostic. A spec may name its base path REPO_ROOT,
// E2E_DIR, __dirname, etc.; what matters is the literal SUBPATH it reads. So we
// match the `scripts/<x>` / `scaffold/<x>` / `theme/<x>` SUBPATH literal AND the
// `path.join/resolve(..., "scripts"|"scaffold"|"theme", ...)` segment form, no
// matter how the prefix variable is spelled. (cms-config-preview-delta.spec.js
// exposed this: it execs `path.join(REPO_ROOT, "scripts/patch-preview-config.sh")`
// — a `REPO_ROOT`-based prefix the original ../scripts-only matcher missed.)
function platformSignals(code, rawSrc = code) {
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
    // #244: a `".github", "workflows"` join is platform-internal UNLESS every
    // such join in the file is rooted at SITE_ROOT (the consumer's own tree)
    // — see allWorkflowsDirJoinsAreSiteRootRooted() above for the full WHY.
    (/\.github["'`]\s*,\s*["'`]workflows["'`]/.test(code) &&
      !allWorkflowsDirJoinsAreSiteRootRooted(rawSrc)) ||
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

// Convenience boolean used by the gate + sabotage proof. `rawSrc` mirrors
// platformSignals()'s optional second parameter.
function isPlatformInternal(code, rawSrc = code) {
  return platformSignals(code, rawSrc).length > 0;
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
      const raw = fs.readFileSync(path.join(E2E_DIR, f), "utf8");
      const code = stripComments(raw);
      const sig = platformSignals(code, raw);
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

    // #244 CARVE-OUT SABOTAGE PROOF — locks allWorkflowsDirJoinsAreSiteRootRooted()
    // itself so it can't silently widen into a no-op (which would re-open the
    // false positive) or, worse, silently widen into suppressing the WHOLE
    // workflows-def signal class (which would blind the guard entirely).
    const siteRootRootedWorkflowsJoin = `
      const path = require("node:path");
      const WF = path.join(process.env.SITE_ROOT, ".github", "workflows");
    `;
    expect(
      isPlatformInternal(stripComments(siteRootRootedWorkflowsJoin), siteRootRootedWorkflowsJoin),
      "a path.join(process.env.SITE_ROOT, '.github', 'workflows') read is the CONSUMER's own " +
        "workflow tree (cms-platform#244's dependabot-theme-gem-ignored.test.js shape) — it must " +
        "NOT be classified platform-internal, or registering it in PLATFORM_META_SPECS would " +
        "testIgnore the #244 guard on every consumer e2e lane, silently voiding it there.",
    ).toBe(false);

    const platformRootedWorkflowsJoin = `
      const path = require("node:path");
      const WF = path.join(__dirname, "..", ".github", "workflows");
    `;
    expect(
      isPlatformInternal(stripComments(platformRootedWorkflowsJoin), platformRootedWorkflowsJoin),
      "a path.join(__dirname, '..', '.github', 'workflows') read carries NO SITE_ROOT anywhere " +
        "— it is the platform's OWN reusable workflow tree and MUST stay classified " +
        "platform-internal; the #244 carve-out must never widen past an ACTUAL SITE_ROOT-rooted join.",
    ).toBe(true);

    const siteRootRootedJoinPlusReadWorkflow = `
      const path = require("node:path");
      const WF = path.join(process.env.SITE_ROOT, ".github", "workflows");
      const { readWorkflow } = require("./workflow-yaml-utils");
    `;
    expect(
      isPlatformInternal(
        stripComments(siteRootRootedJoinPlusReadWorkflow),
        siteRootRootedJoinPlusReadWorkflow,
      ),
      "a spec with a SITE_ROOT-rooted workflows-dir join AND a require('./workflow-yaml-utils') " +
        "call must STILL be classified platform-internal — the carve-out suppresses exactly the " +
        "one '.github'/'workflows' path-join clause, never the whole workflows-def signal class.",
    ).toBe(true);
  });
});

// Exported for any sibling/diagnostic that wants the same classification.
module.exports = { platformSignals, isPlatformInternal, stripComments, metaSpecs };
