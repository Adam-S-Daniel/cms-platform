// @lane: local — PURE-FS single-version guard for the SCAFFOLD TEMPLATE's
// platform pins (NO Jekyll build, NO browser, NO network). Runs in self-ci.yml's
// node-unit-lints lane (picked up automatically — that lane builds its spec list
// by EXCLUSION, so only a build-dependent lint ever needs registering).
//
// ── WHAT ROTTED ───────────────────────────────────────────────────────────
// `examples/site` is the tree `scaffold/create-site.js` copies into every NEW
// site: 33 files — 32 thin workflow callers plus `dependabot.yml`. The callers
// carry 54 platform version REFERENCES: 32 `uses: Adam-S-Daniel/cms-platform/
// …@vX.Y.Z` and 22 `with: platform_ref: vX.Y.Z`. Measured on the pre-fix tree,
// those 54 held NINE DISTINCT versions (v0.1.1 ×40, v0.1.59 ×2, v0.1.52,
// v0.1.46 ×2, v0.1.0, v0.1.6 ×2, v0.1.8 ×2, v0.1.3 ×2, v0.1.58 ×2) — up to 83
// releases stale.
//
// COUNT, re-measured — and NOT the "56 in this tree" an earlier note claimed.
// 56 is the `vX.Y.Z` token count of `.github/workflows` ALONE; across all 33
// files the scaffolder copies it is 59. 59 = 54 refs + FIVE prose tokens that
// must never move: two in the workflows ("real set as of v0.1.79", "secret
// (from v0.1.3)") and three incident citations in `dependabot.yml` (v0.1.6,
// v0.1.80, v0.1.75). A blanket `sed` over this tree corrupts FIVE, not two —
// which is why this lint walks PARSED KEYS rather than matching version-shaped
// text, and why it reads no prose but `scaffold/README.md`'s (see below).
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
// Every platform version reference reachable from a scaffolded site's WORKFLOW
// inputs agrees on ONE version, and that version is the platform's CANONICAL
// one (see "WHAT THIS DOES NOT COVER" for the edges this claim excludes):
//
//   1. `plugin.json` and `.claude-plugin/plugin.json` versions agree.
//   2. Every template reusable `uses: <platform>/…@ref` equals `v<version>`.
//   3. A platform COMPOSITE (`<platform>/.github/actions/…`) is gated by its
//      trailing `# vX.Y.Z` COMMENT — never by its ref, which is a SHA.
//   4. Every template `with: platform_ref:` equals `v<version>`.
//   5. No NON-platform `uses:` in the template carries an `@vX.Y.Z` pin.
//   6. `scaffold/create-site.js`'s `PLATFORM_VERSION` fallback equals
//      `v<version>` — the value an OFFLINE scaffold stamps into every pin.
//   7. `scaffold/README.md` names no platform version but the canonical one.
//
// ── (3) THE COMPOSITE COMMENT, AND WHY A LINE-AWARE PASS ──────────────────
// A parse-only walk is INSUFFICIENT for this shape, and that is not a finding
// invented here: `check-platform-pin-consistency.js:33-38` says so in as many
// words and carries the same line-aware pass, and `platform-bump.yml`'s seeding
// perl rewrites that same trailing comment defensively. The YAML parser DROPS
// comments, so a composite pinned `@v0.1.84  # v0.1.1 (2026-01-01)` reads as
// current to a parse-only walk while its real version gate says v0.1.1
// (measured: the pre-fix version of this lint exited 0 on exactly that file,
// while `verify-consumer-pins.sh`'s awk found the v0.1.1). Following the
// existing precedent also fixes the COUPLED defect: gating a composite on its
// `@ref` told a correctly SHA-pinned one to replace its SHA with a tag — i.e.
// to UN-PIN — which house policy forbids. The ref of a composite is now never
// compared and never named in the advice.
//
// ── (5) THE sub() HAZARD ──────────────────────────────────────────────────
// `create-site.js`'s `sub()` rewrites `@vX.Y.Z` with a VERSION-SHAPED regex,
// not a cms-platform-scoped one. Drop `uses: actions/checkout@v5.0.0` into a
// caller here and every scaffolded site ships `uses: actions/checkout@v0.1.84`
// — an action tag that does not exist. Measured: the pre-fix version of this
// lint exited 0 on exactly that input, because it only ever asserted a property
// of PLATFORM refs while the hazard's trigger is the PRESENCE of a third-party
// semver pin. So this lint applies `sub()`'s OWN rule to every non-platform
// `uses:`, and the constant below is that rule copied verbatim — the detector
// cannot disagree with the transform it guards. House policy (SHA-pin every
// `uses:`, version in a trailing comment) already dodges the hazard: `sub()`
// rewrites no SHA and no comment.
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
//
// ── WHAT THIS DOES NOT COVER (measured; deliberate) ───────────────────────
// The contract is the template's WORKFLOW CALLERS — not "every version token a
// new site inherits". Three known gaps, stated rather than closed:
//
//   • `examples/site/.github/dependabot.yml` is outside the read set. Its three
//     tokens are incident prose today, but `sub()` rewrites NEITHER `@vX.Y.Z`
//     NOR `platform_ref:` in that file's shapes, so a stale `versions:` entry
//     would propagate into a new site UNREWRITTEN — and the site's own
//     `verify-consumer-pins.sh` would not see it either (its scan set is
//     platform.lock / Gemfile* / .github/workflows).
//   • `examples/site/.github/actions/**` — no such directory today. It would be
//     neither walked here nor actionlint'ed (self-ci.yml's template step globs
//     `workflows/*.yml`), though `sub()` WOULD rewrite it on scaffold.
//   • A LOWERCASE-owner ref (`adam-s-daniel/cms-platform@…`, which GitHub
//     resolves) is not classified as a platform ref here. Measured, and
//     NARROWER than it looks: pinned to a full semver it is caught anyway —
//     contract 5 sees a non-platform `uses:` carrying an `@vX.Y.Z` and reds
//     (sole failing test, even with the floor satisfied by a second job). What
//     survives is a lowercase-owner ref pinned to something ELSE — `@main`,
//     `@v1` — which goes green (measured). Pre-existing fleet-wide:
//     check-platform-pin-consistency.js's `classifyUses()` and
//     platform-bump.yml's `\Q$ENV{PLATFORM}\E` rewrite are case-sensitive too,
//     so case-folding here alone would only move the surprise to the next tool.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_WORKFLOWS = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const ROOT_MANIFEST = path.join(REPO_ROOT, "plugin.json");
const CLAUDE_MANIFEST = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const SCAFFOLD_README = path.join(REPO_ROOT, "scaffold", "README.md");
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";
// `sub()`'s own rewrite rule, copied verbatim from scaffold/create-site.js.
// Keep the two identical: this is the detector for contract 5 and it must
// match exactly what the transform would clobber.
const SUB_VERSION_PIN = /@v\d+\.\d+\.\d+/;

const rel = (p) => path.relative(REPO_ROOT, p);

function readVersion(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return String(doc.version || "");
}

// Parse with the `yaml` Document API (anchors/aliases resolved — GitHub has
// allowed them in workflows since 2025-09-18) AND keep each value's 1-based
// SOURCE LINE. Mirrors check-platform-pin-consistency.js's pinNodesWithLines():
// structure comes from the parser, and the line is what the trailing-comment
// pass below needs. Per AGENTS.md ("AST always, never regex, for code-shape
// lints") a lint reasoning about which KEY a value belongs to has to parse.
function pinNodes(text) {
  const doc = YAML.parseDocument(text);
  const uses = [];
  const platformRefs = [];
  const lineOf = (node) => text.slice(0, node.range[0]).split("\n").length;
  YAML.visit(doc, {
    Pair(_i, pair) {
      const key = pair.key && pair.key.value;
      const value = pair.value;
      if (!value || typeof value.value !== "string" || !value.range) return;
      if (key === "uses") uses.push({ uses: value.value, line: lineOf(value) });
      // A non-string `platform_ref` is an input DECLARATION, not a pin; a
      // `${{ … }}` value forwards a parameter and cannot be resolved
      // statically. Both skipped — the same rule the pin checker applies.
      else if (key === "platform_ref" && !value.value.includes("${{")) {
        platformRefs.push({ ref: value.value.trim(), line: lineOf(value) });
      }
    },
  });
  return { uses, platformRefs, lines: text.split("\n") };
}

// LINE-AWARE read of the trailing `# …` comment on a 1-based source line — the
// documented exception to "parse, don't regex", justified at length above. Only
// the COMMENT text is read from source; the `uses:` value itself came from the
// parser. Same shape as check-platform-pin-consistency.js's trailingComment().
function trailingComment(lines, line1) {
  const lineStr = lines[line1 - 1] || "";
  const hash = lineStr.indexOf("#");
  return hash === -1 ? "" : lineStr.slice(hash + 1).trim();
}

// Pull a `vX.Y.Z` token out of a comment like `v0.1.0 (2026-05-29)`.
function versionFromComment(comment) {
  const m = comment.match(/\bv\d+(?:\.\d+){0,3}\b/);
  return m ? m[0] : null;
}

// Mirrors check-platform-pin-consistency.js's classifyUses(), with one
// deliberate widening: a platform ref under some OTHER subpath is still gated
// on its `@ref` here (the pin checker ignores it), because `sub()` rewrites it
// on the way into a new site, so a stale value there does reach a scaffolded
// site.
function classifyUses(usesStr) {
  const at = usesStr.lastIndexOf("@");
  const target = at === -1 ? usesStr : usesStr.slice(0, at);
  const ref = at === -1 ? null : usesStr.slice(at + 1);
  if (target !== PLATFORM_REPO && !target.startsWith(`${PLATFORM_REPO}/`)) {
    return { kind: "third-party", ref, target };
  }
  const subpath = target.slice(PLATFORM_REPO.length + 1);
  if (/^\.github\/actions\/.+$/i.test(subpath)) return { kind: "composite", ref, subpath };
  return { kind: "platform", ref, subpath };
}

function templateFiles() {
  return fs
    .readdirSync(TEMPLATE_WORKFLOWS)
    .filter((f) => /\.ya?ml$/.test(f))
    .sort();
}

function readTemplate(file) {
  return fs.readFileSync(path.join(TEMPLATE_WORKFLOWS, file), "utf8");
}

// Every platform version reference in one file, each reduced to the value that
// must equal the canonical version plus the REMEDY to print when it doesn't.
// The remedy is per-shape on purpose: a composite must be told to fix its
// comment, never its (SHA) ref.
function platformRefsIn(file) {
  const { uses, platformRefs, lines } = pinNodes(readTemplate(file));
  const out = [];
  for (const { uses: value, line } of uses) {
    const cls = classifyUses(value);
    if (cls.kind === "third-party") continue; // contract 5 — its own test below
    if (cls.kind === "composite") {
      out.push({
        kind: "composite",
        found: versionFromComment(trailingComment(lines, line)) || "(no # vX.Y.Z comment)",
        where: `line ${line}: uses: ${value}`,
        remedy: "bring its trailing `# vX.Y.Z (date)` comment to",
      });
      continue;
    }
    out.push({
      kind: "uses",
      found: cls.ref === null ? "(no @ref)" : cls.ref,
      where: `line ${line}: uses: ${value}`,
      remedy: "pin it to",
    });
  }
  for (const { ref, line } of platformRefs) {
    out.push({
      kind: "platform_ref",
      found: ref,
      where: `line ${line}: platform_ref: ${ref}`,
      remedy: "set it to",
    });
  }
  return out;
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
      (f) => !platformRefsIn(f).some((r) => r.kind === "uses" || r.kind === "composite"),
    );

    expect(
      barren,
      `these template workflows yielded NO platform 'uses:' ref: ${barren.join(", ")}.\n\n` +
        `This floor exists so a parser or layout change that stops the walk seeing refs REDS ` +
        `instead of passing vacuously — so first ask which of these two you are looking at:\n` +
        `  (a) The file DOES call a platform reusable and the walk missed it — a parse or ` +
        `classification bug. Fix the walk, not the expectation.\n` +
        `  (b) The file is a legitimate site-local workflow with no platform caller at all ` +
        `(nothing says every template workflow must call one). Then the floor's premise, not ` +
        `the file, is what is stale: narrow it to exempt this file BY NAME, with a comment ` +
        `saying why, so the floor still holds for the other 32. Do not weaken it to "some file ` +
        `somewhere has a ref" — that is the vacuous pass this exists to prevent.`,
    ).toEqual([]);
  });

  test("every template uses:@ref and platform_ref: equals the canonical version", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const offenders = [];
    let checked = 0;

    for (const file of templateFiles()) {
      for (const found of platformRefsIn(file)) {
        checked++;
        if (found.found !== canonical) {
          offenders.push(
            `${file} ${found.where}\n    found ${found.found} — ${found.remedy} ${canonical}`,
          );
        }
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
        `Each line names its own remedy — follow it rather than generalising. In particular a ` +
        `COMPOSITE action's version gate is its trailing comment, so it is asked to fix the ` +
        `COMMENT: never replace a composite's SHA with a tag, which would un-pin it. ` +
        `A maintainer hand-copies callers OUT of this tree (docs/SYNC.md), so a stale pin here ` +
        `becomes a stale pin in a live consumer. If you are cutting a release, bump the ` +
        `manifests, this template and scaffold/create-site.js's PLATFORM_VERSION in the SAME ` +
        `PR — this lint never resolves the tag, so it goes green before the tag exists.`,
    ).toEqual([]);
  });

  test("no NON-platform uses: in the template carries an @vX.Y.Z pin (the sub() hazard)", () => {
    const offenders = [];

    for (const file of templateFiles()) {
      for (const { uses: value, line } of pinNodes(readTemplate(file)).uses) {
        if (classifyUses(value).kind !== "third-party") continue;
        if (SUB_VERSION_PIN.test(value)) offenders.push(`${file} line ${line}: uses: ${value}`);
      }
    }

    expect(
      offenders,
      `${offenders.length} non-platform 'uses:' in ${rel(TEMPLATE_WORKFLOWS)} carry a full ` +
        `semver @ref:\n  ${offenders.join("\n  ")}\n\n` +
        `scaffold/create-site.js's sub() rewrites EVERY '@vX.Y.Z' to the resolved platform ` +
        `version — its rule is version-shaped, not cms-platform-scoped — so each of these ships ` +
        `into every NEW SITE pointing at a tag of the platform repo's version number that the ` +
        `third-party action does not have. Nothing downstream catches it: the pin checker ` +
        `ignores non-platform refs and actionlint does not resolve tags.\n` +
        `Remedy (either closes it): SHA-pin the action with a trailing '# vX.Y.Z (date)' ` +
        `comment, which house policy requires anyway and which sub() does not touch — or scope ` +
        `sub()'s '@vX.Y.Z' rule to '${PLATFORM_REPO}@…' and relax this test with it.\n` +
        `If the offender is cms-platform itself under a different owner CASING, none of that ` +
        `applies: fix the casing to '${PLATFORM_REPO}'. Every tool in this chain is ` +
        `case-sensitive (the pin checker's classifyUses(), platform-bump.yml's rewrite, this ` +
        `lint), so a mis-cased ref is not being version-checked at all — it only landed here ` +
        `because a version-shaped pin is the one thing that still shows through.`,
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

  test("scaffold/README.md names no platform version but the canonical one", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const text = fs.readFileSync(SCAFFOLD_README, "utf8");
    const stale = (text.match(/\bv\d+\.\d+\.\d+\b/g) || []).filter((v) => v !== canonical);

    expect(
      stale,
      `${rel(SCAFFOLD_README)} names ${stale.length} non-canonical platform version(s): ` +
        `${[...new Set(stale)].join(", ")} (canonical is ${canonical}).\n\n` +
        `This file used to describe the offline fallback as "currently v0.1.52" — a SECOND copy ` +
        `of PLATFORM_VERSION, in prose, that no guard read. It sat 32 releases stale, and the ` +
        `commit that bumped the constant to v0.1.84 left it behind, which is how this ` +
        `assertion came to exist.\n` +
        `Remedy depends on what you wrote:\n` +
        `  • Describing the fallback? Do not repeat its value — name the PLATFORM_VERSION ` +
        `constant instead. The value has exactly one home, and the test above guards it.\n` +
        `  • A historical note ("since vX.Y.Z …")? It belongs in docs/VERSION-HISTORY.md, ` +
        `which is where this repo keeps release-indexed prose. This file is a 60-line ` +
        `how-to and is version-free by policy.\n` +
        `  • Genuinely the current version? Then it must read ${canonical}, and you have ` +
        `signed up to bump it in every release PR — prefer one of the two above.`,
    ).toEqual([]);
  });
});
