// @lane: local — PURE-FS single-version guard for the SCAFFOLD TEMPLATE's
// platform pins (NO Jekyll build, NO browser, NO network, no child process).
// Runs in self-ci.yml's node-unit-lints lane (picked up automatically — that
// lane builds its spec list by EXCLUSION, so only a build-dependent lint ever
// needs registering).
//
// ── WHAT ROTTED ───────────────────────────────────────────────────────────
// `examples/site` is the tree `scaffold/create-site.js` copies into every NEW
// site: 33 files — 32 thin workflow callers plus `dependabot.yml`. The callers
// carry 54 platform version REFERENCES: 32 `uses: Adam-S-Daniel/cms-platform/
// …@vX.Y.Z` and 22 `with: platform_ref: vX.Y.Z`. Measured on the pre-fix tree,
// those 54 held NINE DISTINCT versions (v0.1.1 ×40, v0.1.59 ×2, v0.1.52,
// v0.1.46 ×2, v0.1.0, v0.1.6 ×2, v0.1.8 ×2, v0.1.3 ×2, v0.1.58 ×2) — up to 83
// releases stale. Nothing read those values: check-platform-pin-consistency.js
// NORMALISES `@vX.Y.Z` → `@vREF` before comparing (so it can compare pin SHAPES
// across a repo), which makes it structurally blind to them, and both real
// consumers passed at v0.1.84 against the fully-rotted template.
//
// The rot's victim is a human: docs/SYNC.md tells a maintainer to re-copy thin
// callers FROM this tree when adopting a new workflow. Hand-copy one and you
// import a v0.1.1 pin into a live consumer, which that consumer's own pin gate
// then reds — far from the cause.
//
// ── WHAT THIS GUARD PROVES, EXACTLY ───────────────────────────────────────
// Not "every version token a new site inherits" — a claim two earlier rounds
// made and measurement refuted twice. What it proves is one thing, and it is
// the thing that matters:
//
//   Every template WORKFLOW file — as written, AND as `substitute()` would
//   rewrite it into a new site — is clean under the SAME rules the consumer's
//   own `scripts/verify-consumer-pins.sh` applies. Not equivalent rules. The
//   same code: RULE A is `scripts/stale-platform-refs.js`, the module that
//   script's stale-pin check literally runs, `require`d here; RULE B parses,
//   mirroring the checker that script shells out to.
//
// The consequence is the property that was missing: a drift shape that would
// red a scaffolded site's gate reds THIS lint first, on the platform PR that
// introduced it. Rounds 1 and 2 shipped a re-derived parse-only detector and
// each time a NEW spelling split the two — a composite's trailing comment, then
// a reusable's, then a `platform_ref:` line's. See e2e/template-pin-rules.js for
// why two rules replace that enumeration, and
// examples-site-scaffold-agreement.test.js for the end-to-end proof (it
// scaffolds from a DRIFTED template and runs the real shell gate on the result).
//
// ── THE CONTRACTS ─────────────────────────────────────────────────────────
//   1. `plugin.json` and `.claude-plugin/plugin.json` versions agree.
//   2. FLOOR: every template workflow yields at least one platform `uses:` ref.
//   3. Every template workflow, AS WRITTEN, is clean under Rule A ∪ Rule B.
//   4. Every template workflow, AS `substitute()` WOULD EMIT IT, likewise —
//      the bytes a new site actually receives, scanned by the scanner that
//      site's own gate will run.
//   5. `substitute()` is ANCHORED to the platform slug: it rewrites a platform
//      `@vX.Y.Z` — in ANY owner casing — and leaves every other `@vX.Y.Z` alone.
//   6. `scaffold/create-site.js`'s `PLATFORM_VERSION` fallback equals
//      `v<version>` — the value an OFFLINE scaffold stamps into every pin.
//   7. `scaffold/README.md` names no platform version but the canonical one.
//
// Contract 3 also rejects a MIS-CASED platform slug (`adam-s-daniel/…`, which
// GitHub happily resolves) outright, with "fix the casing" rather than a version
// remedy. That is a rule about ref IDENTITY, not another version position: every
// case-sensitive tool downstream — the pin checker's classifyUses(), the
// consumer gate's slug test, platform-bump.yml's `\Q…\E` rewrite — silently
// stops version-checking such a ref, so the one tree we own must refuse it. It
// replaces the accidental coverage the old "no third-party @vX.Y.Z" test gave
// this shape, and it closes it for `@main` / `@v1` too, which that test never
// reached.
//
// ── (4) AND (5): THE sub() HAZARD, FIXED AT THE TRANSFORM ─────────────────
// `substitute()`'s pin rule used to be version-shaped rather than
// cms-platform-scoped, so it clobbered ANY `@vX.Y.Z` in the file text —
// `- run: pip install some-tool@v2.3.4` shipped as `some-tool@v0.1.84` into
// every new site, seen by nothing (measured: guard 0, actionlint 0, new site's
// own gate 0, and the site broken). Round 2 answered it with a lint listing the
// positions where that could happen; `run:` was not on the list. The transform
// is now anchored, which removes the hazard rather than enumerating it, and
// contract 5 tests the TRANSFORM's behaviour instead of the template's contents
// — so it stays true no matter what a future caller contains.
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
// deliberately rejected: vNEXT would be unpublishable and the lint would take a
// network dependency and stop being deterministic.
//
// ── NON-DEGRADATION ───────────────────────────────────────────────────────
// A lint that silently finds NOTHING passes vacuously — the failure mode
// `--require-canonical` was added to check-platform-pin-consistency.js to close.
// So contract 2 asserts a structural FLOOR, and contract 3 additionally asserts
// it walked a non-zero number of refs.
//
// ── OUTSIDE THE CONTRACT (measured; deliberate; NOT claimed complete) ──────
// This list is what has been MEASURED to fall outside, not a proof that nothing
// else does — the last two rounds each shipped a "complete" gap list that the
// next measurement refuted, so it is not claimed again here. Both entries are
// outside the CONSUMER GATE too, which is why they do not split the two:
//
//   • `examples/site/.github/dependabot.yml` — not a workflow, so neither this
//     lint's read set nor `verify-consumer-pins.sh`'s scan set (platform.lock /
//     Gemfile* / .github/workflows) covers it. Its three tokens are incident
//     prose today; `substitute()` rewrites neither shape it uses, so a stale
//     `versions:` entry would reach a new site unrewritten and unseen at both
//     ends.
//   • A THIRD-PARTY `uses:` pinned to a full semver is no longer an offence
//     here, and that is a deliberate substitution rather than a lost control.
//     It was only ever an offence because `substitute()`'s version-shaped rule
//     would clobber it; the rule is anchored now, so `actions/checkout@v5.0.0`
//     ships verbatim (measured) and there is nothing left to catch. Contract 5
//     replaced it by testing the TRANSFORM directly — which also covers the
//     `run:`-line position the old template-content test structurally could not
//     see, and is the reason the hazard is closed rather than enumerated.
//   • Rule A's LINE predicate is slug-cased (its `platform_ref` /
//     `cms-platform-theme` / `tag:` clauses are not), inherited from the
//     consumer gate it is shared with. Contract 3 refusing a mis-cased `uses:`
//     covers the shape that matters; a mis-cased slug in some OTHER line
//     position, carrying a stale token, would be seen by neither. Unmeasured
//     shapes may exist — two rounds of "these are the gaps" were refuted by the
//     next measurement, so this list is what has been measured, not a proof of
//     completeness. The end-to-end table in
//     examples-site-scaffold-agreement.test.js is what actually holds the line.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { formatOffence, offences, pinNodes, classifyUses } = require("./template-pin-rules");

const REPO_ROOT = path.resolve(__dirname, "..");
const TEMPLATE_WORKFLOWS = path.join(REPO_ROOT, "examples", "site", ".github", "workflows");
const ROOT_MANIFEST = path.join(REPO_ROOT, "plugin.json");
const CLAUDE_MANIFEST = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
const SCAFFOLD_README = path.join(REPO_ROOT, "scaffold", "README.md");
const { PLATFORM_REPO, substitute } = require("../scaffold/create-site.js");

const rel = (p) => path.relative(REPO_ROOT, p);

function readVersion(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return String(doc.version || "");
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

// The bytes a scaffolded site receives for this file. Uses the REAL transform,
// with the REAL canonical version — the default domain, so the identity
// rewrites are an identity and only the pin rules move.
function asScaffolded(text, canonical) {
  return substitute(text, {
    prefix: "example-com",
    domain: "example.com",
    platformVersion: canonical,
  });
}

const REPORT_TAIL =
  `\n\nEach line names its own remedy — follow it rather than generalising. EVERY ` +
  `cross-repo platform ref — reusable workflow AND composite action — is pinned ` +
  `by TAG, so every remedy names the @ref (including when that ref is a SHA: the ` +
  `pin checker fails a SHA-pinned platform ref, so "fix the comment instead" ` +
  `would make this lint green where the consumer gate is red). A composite was ` +
  `SHA-pinned with its gate in a trailing comment until 2026-08-20; that comment ` +
  `is retired and a uses: line now ends at its ref.\n` +
  `A maintainer hand-copies callers OUT of this tree (docs/SYNC.md), so a stale ` +
  `pin here becomes a stale pin in a live consumer. If you are cutting a ` +
  `release, bump the manifests, this template and scaffold/create-site.js's ` +
  `PLATFORM_VERSION in the SAME PR — this lint never resolves the tag, so it ` +
  `goes green before the tag exists.`;

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
        !pinNodes(readTemplate(f)).uses.some((u) => classifyUses(u.uses).kind !== "third-party"),
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

  test("every template workflow AS WRITTEN is clean under the consumer gate's own rules", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const found = [];
    let refs = 0;

    for (const file of templateFiles()) {
      const text = readTemplate(file);
      refs += pinNodes(text).uses.length + pinNodes(text).platformRefs.length;
      for (const o of offences(text, { canonical, file })) {
        found.push(`${file} ${formatOffence(o, canonical)}`);
      }
    }

    expect(
      refs,
      `walked ${rel(TEMPLATE_WORKFLOWS)} and found ZERO 'uses:' / 'platform_ref:' nodes — this ` +
        `lint would pass vacuously. Investigate the walk before trusting a green run.`,
    ).toBeGreaterThan(0);

    expect(
      found,
      `${found.length} platform version reference(s) in ${rel(TEMPLATE_WORKFLOWS)} disagree with ` +
        `the canonical ${canonical} (from ${rel(ROOT_MANIFEST)}):\n  ${found.join("\n  ")}` +
        REPORT_TAIL,
    ).toEqual([]);
  });

  test("every template workflow AS SCAFFOLDED is clean under those same rules", () => {
    const canonical = `v${readVersion(ROOT_MANIFEST)}`;
    const found = [];
    let before = 0;
    let after = 0;

    for (const file of templateFiles()) {
      const template = readTemplate(file);
      const scaffolded = asScaffolded(template, canonical);
      const count = (t) => {
        const n = pinNodes(t);
        return n.uses.length + n.platformRefs.length;
      };
      before += count(template);
      after += count(scaffolded);
      for (const o of offences(scaffolded, { canonical, file })) {
        found.push(`${file} ${formatOffence(o, canonical)}`);
      }
    }

    // FLOOR, mirroring the one on the AS-WRITTEN test: an empty or ref-less
    // scaffolded text would make every assertion below pass vacuously. The
    // equality is the sharper half — substitute() rewrites VALUES, so it must
    // never add or drop a `uses:` / `platform_ref:` node.
    expect(
      after,
      `substitute() changed the NUMBER of pin nodes: ${before} in the template, ${after} in the ` +
        `scaffolded output. It rewrites VALUES only, so this means it mangled the YAML (or this ` +
        `test scanned the wrong text and is now passing vacuously). Investigate before trusting ` +
        `a green run.`,
    ).toBe(before);
    expect(after, "no pin nodes scanned — this test would pass vacuously").toBeGreaterThan(0);

    expect(
      found,
      `${found.length} platform version reference(s) survive scaffold/create-site.js's ` +
        `substitute() into a NEW SITE:\n  ${found.join("\n  ")}\n\n` +
        `These are the actual bytes a scaffolded site receives, checked with the same module ` +
        `that site's own scripts/verify-consumer-pins.sh runs — so each of these is a site that ` +
        `would be BORN failing its own pin gate. substitute() normalises a platform '@vX.Y.Z' ` +
        `and a 'platform_ref:' VALUE and nothing else (deliberately: repairing comments would ` +
        `hide template rot from the test above), so the fix belongs in the TEMPLATE, not in the ` +
        `transform.`,
    ).toEqual([]);
  });

  test("substitute() rewrites ONLY a platform @ref (the sub() hazard, fixed at the source)", () => {
    const V = "v9.9.9";
    const sub = (s) =>
      substitute(s, { prefix: "example-com", domain: "example.com", platformVersion: V });

    // Platform refs — every subpath shape, plus the bare repo — are rewritten.
    expect(sub(`uses: ${PLATFORM_REPO}/.github/workflows/e2e-tests.yml@v0.1.1`)).toBe(
      `uses: ${PLATFORM_REPO}/.github/workflows/e2e-tests.yml@${V}`,
    );
    expect(sub(`uses: ${PLATFORM_REPO}/.github/actions/recursion-gate@v0.1.1`)).toBe(
      `uses: ${PLATFORM_REPO}/.github/actions/recursion-gate@${V}`,
    );
    expect(sub(`uses: ${PLATFORM_REPO}@v0.1.1`)).toBe(`uses: ${PLATFORM_REPO}@${V}`);
    expect(sub("      platform_ref: v0.1.1")).toBe(`      platform_ref: ${V}`);

    // …and NOTHING else is. Each of these was rewritten by the version-shaped
    // rule this anchor replaced; the `run:` one shipped a broken new site.
    const untouched = [
      "      - uses: actions/checkout@v5.0.0",
      "      - run: pip install some-tool@v2.3.4",
      "      # pattern lifted from some-org/some-repo@v1.2.3",
      "      IMAGE: ghcr.io/example/tool@v3.0.0",
    ];
    for (const line of untouched) {
      expect(
        sub(line),
        `substitute() rewrote a NON-platform '@vX.Y.Z':\n  in:  ${line}\n  out: ${sub(line)}\n\n` +
          `Its pin rule must stay ANCHORED to '${PLATFORM_REPO}'. A version-shaped rule clobbers ` +
          `third-party pins and any version-shaped text, in EVERY scaffolded site, and nothing ` +
          `downstream sees it: actionlint does not resolve tags, the pin checker ignores ` +
          `non-platform refs, and a non-platform token is not a platform ref to the new site's ` +
          `own verify-consumer-pins.sh. Fix the transform — a lint enumerating the positions ` +
          `where this can happen is what this assertion replaced.`,
      ).toBe(line);
    }
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
