// @lane: local — pure-fs invariants on _e2e canary collection wiring.
//
// The prod `_posts/` canary body byte-lock (#1771 step 3) was REMOVED by
// #1771 step 4: the two persistent prod fixtures became EPHEMERAL,
// born-published, hard-deleted per-run posts (resting state = absence;
// see e2e/prod-mutate-fixture.js). There is no persistent prod body left
// to byte-lock — the corruption class is gone by construction. The `_e2e/`
// canaries below stay persistent (the always-on @canary-readonly probe
// target) and keep their byte-lock.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { CANARIES, readCanarySource, stripInFlightMarker } = require("./canary-content");
const cap = require("./site-capabilities");

// SITE_ROOT-aware resolution of the RENDERED Decap config. The gem's render
// hook (scripts/render-decap-config.rb) emits the live config to
// `<site>/_site/admin/config.yml` during the local-lane build — the source
// `admin/config.yml` doesn't exist (the platform ships only the
// `config.base.yml` template). The checked-in `_e2e/*.md` canary files this
// spec byte-locks are REAL content fixtures and stay at the site root; both
// the config.yml read and the `_config.yml` / `_e2e` source reads are
// SITE_ROOT-rooted (so they resolve to the CONSUMING site — the same root the
// harness sits at in a consumer, and the meta-test points at a fixture).
const SITE_ROOT = process.env.SITE_ROOT || path.join(__dirname, "..");
const RENDERED_CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");

// #33 — a single-page consumer that opts out of the `e2e` collection via
// cms.base_collections (v0.1.7) ships NO `_e2e/` canary fixtures and renders no
// `e2e` collection. These invariants byte-lock the canaries + their admin
// wiring, so they only apply where the canaries exist. Skip PRECISELY (keyed
// on the actual presence of `_e2e/canary-*.md` under SITE_ROOT) when genuinely
// absent; the full fixture-site + adamdaniel.ai have them, so this runs
// unchanged there. NB: keep this distinct from the existing "rendered config
// not built" self-skip below — that one is about lane (preview/prod don't
// build `_site`), this one is about the consumer opting out of the collection.
const HAS_CANARIES = cap.hasE2ECanaries(SITE_ROOT);

test.describe("Canary content invariants", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(() => {
    test.skip(
      !HAS_CANARIES,
      "consumer opts out of the e2e canary collection via cms.base_collections — no _e2e/canary-*.md to byte-lock (#33)",
    );
  });

  test("every canary descriptor matches a checked-in source file", () => {
    for (const c of CANARIES) {
      const src = readCanarySource(c);
      // The baseline text MUST appear verbatim in the source body. The
      // cleanup step writes it back after each test run, so a drift
      // here means the canary doesn't reset to the same content the
      // descriptor claims.
      expect(src, `${c.path} body must contain the baseline string`).toContain(c.baseline);
      // The FULL canonical body (title sentence + explanatory paragraphs
      // + footer) must also match the checked-in file byte-for-byte.
      // Without this assertion the canary file could drift gradually —
      // e.g., a Decap WYSIWYG round-trip doubles newlines (PR #882) —
      // and the publish-loop spec's UI cleanup would silently produce a
      // mangled cms/e2e/* PR that disagrees with the API-path setup
      // reset, leaving conflicting PRs in their wake.
      const fmEnd = src.indexOf("\n---\n", 4);
      expect(fmEnd, `${c.path} must have a closing front-matter delimiter`).toBeGreaterThan(0);
      const fileBody = src
        .slice(fmEnd + 5)
        .replace(/^\n+/, "")
        .replace(/\n+$/, "");
      // The host publish-loop opens a canary PR whose body carries ONE
      // transient `e2e-publish-loop:<id>:<runId>` marker (it injects the marker,
      // drives publish, and resets to baseline in cleanup). That canary PR runs
      // THIS byte-lock as a required e2e check, so a strict `=== baselineBody`
      // here rejected the loop's OWN in-flight PR → it could never auto-merge and
      // the host publish-loop was never green (#1815 host leg; the loop's heavy
      // job had been failing 40+ runs straight). Strip AT MOST ONE marker, then
      // require the remainder to equal the baseline byte-for-byte: real drift
      // (Decap newline-doubling — the #882 class — content rot) and the
      // multi-marker orphan pathology (#1861) still fail loud; a lone orphan left
      // on main is reset by the loop's self-heal (scripts/reset-orphaned-canary.sh).
      expect(
        stripInFlightMarker(fileBody),
        `${c.path} body must match the canonical buildBaselineBody() output verbatim (modulo at most one in-flight e2e-publish-loop marker) — drift (Decap newline-doubling / content rot / a multi-marker orphan) breaks the publish-loop cleanup contract`,
      ).toBe(c.baselineBody);
      expect(src).toContain(`canary_id: ${c.id}`);
      expect(src).toContain(`permalink: ${c.publicPath}`);
      expect(src).toMatch(/^layout: canary$/m);
      expect(src).toMatch(/^robots: noindex,nofollow$/m);
      expect(src).toMatch(/^sitemap: false$/m);
    }
  });

  test("admin/config.yml exposes the e2e canary collection", () => {
    // The rendered config only exists after the local Jekyll build + render
    // hook run; skip (rather than ENOENT-fail) when `_site` isn't built —
    // mirrors the sitemap.spec self-skip for the preview/prod lanes.
    test.skip(
      !fs.existsSync(RENDERED_CONFIG),
      `${RENDERED_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config canary check only runs in the local lane`,
    );
    const cfg = fs.readFileSync(RENDERED_CONFIG, "utf8");
    // The publish-loop test drives admin actions on this collection.
    // If it disappears, the test goes silently green (no PR opened ≠
    // success) — fail loudly here.
    expect(cfg).toMatch(/^\s{2}- name: e2e\s*$/m);
    // Both `create: true` and `delete: true` are required:
    //   - `delete: true` lets `cms-delete-published.spec.js` click
    //     the Decap UI's "Delete published entry" menuitem (Decap
    //     renders that menuitem only when the collection allows
    //     deletes).
    //   - `create: true` lets the same spec drive the editor's
    //     "+ New E2E Canary" form to seed its throw-away fixture
    //     via UI instead of the `seedFixtureViaPr` API back door
    //     (per AGENTS.md "no back doors in setup or cleanup").
    // The "[E2E TEST FIXTURES — DO NOT EDIT]" collection label is
    // the convention-only guardrail against accidental editor-driven
    // mutation.
    expect(cfg).toMatch(/^\s{4}folder: _e2e\s*$/m);
    expect(cfg).toMatch(/^\s{4}create: true\s*$/m);
    expect(cfg).toMatch(/^\s{4}delete: true\s*$/m);

    // The body field MUST be `widget: text` (plain HTML textarea), not
    // `widget: markdown` (Slate WYSIWYG). With `widget: markdown`,
    // saving via the editor round-trips through Slate and every soft
    // line wrap inside a paragraph comes back doubled as a paragraph
    // break (PR #882: `\n` → `\n\n`, `\n\n` → `\n\n\n\n`, plus the
    // blank line between frontmatter `---` and the first paragraph
    // gets eaten). The publish-loop spec's UI cleanup then produces a
    // file that disagrees with the canonical baseline; the cms/e2e/*
    // PR Decap opens conflicts with main as soon as the next run's
    // safety-net pushes a clean baseline.
    const e2eStart = cfg.search(/^\s{2}- name: e2e\s*$/m);
    expect(e2eStart, "e2e collection must be present").toBeGreaterThan(-1);
    // Slice from the e2e collection start to the next top-level
    // collection (or EOF) so the body-field regex can't match a body
    // field from a different collection (posts/projects/pages).
    const nextCollection = cfg.slice(e2eStart + 1).search(/^\s{2}- name: \w/m);
    const e2eBlock =
      nextCollection < 0 ? cfg.slice(e2eStart) : cfg.slice(e2eStart, e2eStart + 1 + nextCollection);
    expect(e2eBlock).toMatch(/^\s{6}- name: body\s*$/m);
    expect(
      e2eBlock,
      "e2e body field MUST be widget: text — widget: markdown breaks the publish-loop cleanup contract (see PR #882)",
    ).toMatch(/^\s{6}- name: body\s*\n(?:\s{6,}.+\n)*?\s{8}widget: text\s*$/m);
    // Negative assertion: explicitly forbid the dangerous widget on the
    // e2e body. (The positive assertion above would catch a missing
    // `widget: text`, but a misindented `widget: markdown` could
    // theoretically slip through; this makes the intent loud.)
    const e2eBody = e2eBlock.match(
      // eslint-disable-next-line no-useless-escape -- `\Z` is a literal end-of-input fallback in the lookahead alternation; kept verbatim to preserve the existing match behavior of this YAML-structure scan.
      /^\s{6}- name: body\s*\n(?:\s{6,}.+\n)+?(?=\s{0,6}-|\s{0,4}- name|\Z)/m,
    );
    if (e2eBody) {
      expect(e2eBody[0]).not.toMatch(/^\s{8}widget: markdown\s*$/m);
    }
  });

  test("_config.yml registers the e2e collection with the right permalink", () => {
    const cfg = fs.readFileSync(path.join(SITE_ROOT, "_config.yml"), "utf8");
    // Without `output: true` Jekyll won't render an HTML file; the
    // publish-loop's "assert it shows up at the public URL" step would
    // never satisfy.
    expect(cfg).toMatch(/^\s{2}e2e:/m);
    expect(cfg).toMatch(/output:\s*true/);
    expect(cfg).toMatch(/permalink:\s*\/e2e\/:slug\//);
    // Defaults must propagate the noindex + sitemap-exclude so an editor
    // who clones a canary doesn't accidentally publish it to search.
    expect(cfg).toMatch(/sitemap:\s*false/);
    expect(cfg).toMatch(/robots:\s*"noindex,nofollow"/);
  });
});

