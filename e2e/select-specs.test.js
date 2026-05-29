// @lane: local — pure-Node unit tests for the e2e spec selector
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  selectSpecs,
  ALWAYS_RUN,
  HEAVY,
  parseSpecDirectives,
  pickShardCount,
  selectParityPreviewSpecs,
  PARITY_PREVIEW_SPECS,
  FANOUT_PATTERNS,
  RENDER_FANOUT_PATTERNS,
  TEST_INFRA_FANOUT_PATTERNS,
} = require("./select-specs");

// Pure-function unit tests for the e2e spec selector. No browser, no
// git — just verify each rule fires correctly.

test.describe("select-specs", () => {
  test("empty changeset → skip with baseline", () => {
    const r = selectSpecs([]);
    expect(r.scope).toBe("skip");
  });

  test("only docs → skip with baseline", () => {
    const r = selectSpecs(["README.md", "AGENTS.md", "docs/CONTENT_GUIDE.md"]);
    expect(r.scope).toBe("skip");
  });

  test("layout change → fanout to all specs", () => {
    const r = selectSpecs(["_layouts/post.html"]);
    expect(r.scope).toBe("all");
  });

  test("_config.yml change → fanout", () => {
    const r = selectSpecs(["_config.yml"]);
    expect(r.scope).toBe("all");
  });

  test("CSS change → fanout (visual regression covers it)", () => {
    const r = selectSpecs(["assets/css/main.css"]);
    expect(r.scope).toBe("all");
  });

  test("single post change → posts-related specs only", () => {
    const r = selectSpecs(["_posts/2026-04-25-something.md"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-smoke.spec.js");
    expect(r.files).toContain("e2e/cms-editorial-workflow.spec.js");
    expect(r.files).toContain("e2e/blog-post.spec.js");
    expect(r.files).toContain("e2e/visual-regression.spec.js");
    // CMS preview-url is post-specific
    expect(r.files).toContain("e2e/cms-preview-url.spec.js");
    // Infrastructure isn't relevant
    expect(r.files).not.toContain("e2e/cloudfront-preview-router.spec.js");
    // Always-run baseline included
    for (const a of ALWAYS_RUN) expect(r.files).toContain(a);
  });

  test("admin/reviews change → reviews specs only", () => {
    const r = selectSpecs(["admin/reviews/index.html"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/admin-reviews-auth.spec.js");
    expect(r.files).toContain("e2e/admin-reviews-stats.spec.js");
    expect(r.files).not.toContain("e2e/blog-post.spec.js");
    expect(r.files).not.toContain("e2e/cloudfront-preview-router.spec.js");
  });

  test("oauth-proxy change → reviews-auth spec runs (proxy is the popup)", () => {
    const r = selectSpecs(["oauth-proxy/lambda.py"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/admin-reviews-auth.spec.js");
  });

  test("admin/config.yml change → CMS specs only", () => {
    const r = selectSpecs(["admin/config.yml"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-smoke.spec.js");
    expect(r.files).toContain("e2e/cms-editorial-workflow.spec.js");
    expect(r.files).toContain("e2e/cms-config.spec.js");
    expect(r.files).toContain("e2e/cms-preview-url.spec.js");
    // Layouts aren't touched, so no fanout to e.g. CloudFront specs.
    expect(r.files).not.toContain("e2e/cloudfront-preview-router.spec.js");
  });

  test("admin/config-test.yml change → editorial workflow + config specs", () => {
    const r = selectSpecs(["admin/config-test.yml"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-editorial-workflow.spec.js");
    expect(r.files).toContain("e2e/cms-config.spec.js");
  });

  test("infrastructure change → cloudfront specs only", () => {
    const r = selectSpecs(["infrastructure/bootstrap/template.yaml"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cloudfront-preview-router.spec.js");
    expect(r.files).toContain("e2e/cloudfront-preview-location-fixer.spec.js");
    expect(r.files).not.toContain("e2e/admin-cms.spec.js");
  });

  test("a spec file's own change → that spec runs", () => {
    const r = selectSpecs(["e2e/glow-banding.spec.js"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/glow-banding.spec.js");
  });

  test("compute-visual-diffs JS change → diff-related specs run", () => {
    const r = selectSpecs(["e2e/compute-visual-diffs.js"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/compute-visual-diffs.test.js");
    expect(r.files).toContain("e2e/admin-reviews-stats.spec.js");
  });

  test("plugin change → fanout (plugins affect rendered output)", () => {
    const r = selectSpecs(["_plugins/auto_tag_pages.rb"]);
    expect(r.scope).toBe("all");
  });

  test("mixed: tag + post change → CMS smoke + blog/tags page specs", () => {
    const r = selectSpecs(["_tags/python.md", "_posts/2026-01-01-hi.md"]);
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-smoke.spec.js");
    expect(r.files).toContain("e2e/blog-post.spec.js");
    expect(r.files).toContain("e2e/tags.spec.js");
  });

  test("disableSkip: docs change still runs baseline rather than skip", () => {
    const r = selectSpecs(["README.md"], { disableSkip: true });
    expect(r.scope).toBe("subset");
    // Baseline only — none of the CRUD specs.
    expect(r.files).toEqual(ALWAYS_RUN.slice().sort());
  });

  test("non-doc change that matches no SPEC_RULES collapses to skip", () => {
    // The skills-mirror unification PR's signature: lots of files
    // touched (tests/, scripts/, .githooks/, .claude/, _plugins_test/)
    // but none match any spec rule or fanout pattern. Without the
    // collapse this returns subset = ALWAYS_RUN, which is identical to
    // scope=skip but pays for a full 4-way matrix.
    const r = selectSpecs([
      "tests/test_bootstrap.py",
      "scripts/bootstrap.sh",
      ".githooks/pre-commit",
      "pyproject.toml",
    ]);
    expect(r.scope).toBe("skip");
  });

  test("disableSkip: baseline-only collapse is also bypassed", () => {
    const r = selectSpecs(["tests/test_bootstrap.py"], { disableSkip: true });
    expect(r.scope).toBe("subset");
    expect(r.files).toEqual(ALWAYS_RUN.slice().sort());
  });

  test("canary collection edit on default (local) lane → baseline-only collapse to skip", () => {
    // _e2e/* matches publish-loop (real) + canary-content (always-run
    // baseline, local). After local-lane filtering, real specs are
    // dropped and only the baseline remains — which collapses to skip.
    // The next test asserts the real-lane view of the same change.
    const r = selectSpecs(["_e2e/canary-post.md"]);
    expect(r.scope).toBe("skip");
  });

  test("canary collection edit on lane=real → publish-loop specs only", () => {
    const r = selectSpecs(["_e2e/canary-post.md"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.files).toContain("e2e/cms-publish-loop-preview.spec.js");
    // canary-content.test.js is @lane: local so it doesn't survive.
    expect(r.files).not.toContain("e2e/canary-content.test.js");
  });

  test("canary layout change → canary invariants run", () => {
    const r = selectSpecs(["_layouts/canary.html"]);
    // _layouts/* is a fanout pattern, so we expect scope=all here.
    expect(r.scope).toBe("all");
  });

  test("github-actions-poll helper change → publish-loop specs (lane=real)", () => {
    // The publish-loop specs are @lane: real, so the default-lane run
    // collapses to skip; the real-lane view selects them.
    const r = selectSpecs(["e2e/github-actions-poll.js"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.files).toContain("e2e/cms-publish-loop-preview.spec.js");
  });

  test("decap-pat helper change → publish-loop specs (lane=real)", () => {
    const r = selectSpecs(["e2e/decap-pat.js"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.files).toContain("e2e/cms-publish-loop-preview.spec.js");
  });

  // ── Preview delete-published spec (issue #1004) ────────────────────

  test("cms-delete-published-preview is registered HEAVY (shard-budget neutral)", () => {
    expect(HEAVY.has("e2e/cms-delete-published-preview.spec.js")).toBe(true);
  });

  test("admin/ change selects the preview delete spec (lane=real)", () => {
    const r = selectSpecs(["admin/index.html"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-delete-published-preview.spec.js");
  });

  test("its dedicated workflow change selects the preview delete spec (lane=real)", () => {
    const r = selectSpecs([".github/workflows/cms-delete-published-preview.yml"], { lane: "real" });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-delete-published-preview.spec.js");
  });

  test("run-cms-loop spine change → preview delete spec (real) + run-cms-loop unit test (local)", () => {
    const real = selectSpecs(["e2e/run-cms-loop.js"], { lane: "real" });
    expect(real.scope).toBe("subset");
    expect(real.files).toContain("e2e/cms-delete-published-preview.spec.js");

    const local = selectSpecs(["e2e/run-cms-loop.js"], { lane: "local" });
    expect(local.scope).toBe("subset");
    expect(local.files).toContain("e2e/run-cms-loop.test.js");
  });

  test("cms/* head ref drops the preview delete spec (self-skips at runtime anyway)", () => {
    // admin/ change selects it; the @select-skip-when-head-ref-prefix:
    // cms/ directive takes it back out on cms/* head refs. Pin
    // lane=real so it's in play pre-directive (see the publish-loop
    // directive tests for the rationale).
    const r = selectSpecs(["admin/index.html"], {
      headRef: "cms/foo",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).not.toContain("e2e/cms-delete-published-preview.spec.js");
    expect(r.skippedByDirective).toContain("e2e/cms-delete-published-preview.spec.js");
  });

  // ── Spec-header directives (Layer 3.A) ──────────────────────────────
  // The directive parser reads ~500 bytes from the head of a spec file
  // and extracts `// @key: value` lines. The select-skip-when-head-ref-
  // prefix directive lets a spec opt out of selection on certain branch
  // prefixes (e.g. `cms/*` Decap-opened editorial PRs), eliminating the
  // bring-up cost of specs that self-skip at runtime anyway.

  test("parseSpecDirectives extracts skipWhenHeadRefPrefix from a spec header", () => {
    // Use a tmp fixture rather than depending on the real spec files —
    // keeps the test stable when the in-tree directive list changes.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "select-directives-"));
    try {
      const fixture = path.join(tmp, "fixture.spec.js");
      fs.writeFileSync(
        fixture,
        [
          "// @select-skip-when-head-ref-prefix: cms/, dependabot/",
          "//",
          "// Stub spec used by select-specs.test.js.",
          "const { test } = require('./base');",
          "test('noop', () => {});",
          "",
        ].join("\n"),
      );
      const d = parseSpecDirectives(fixture);
      expect(d.skipWhenHeadRefPrefix).toEqual(["cms/", "dependabot/"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("parseSpecDirectives also matches inside a JSDoc-style block comment", () => {
    // Real spec files in this repo use leading `/* ... */` blocks.
    // The parser must recognise ` * @key: value` lines as well.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "select-directives-"));
    try {
      const fixture = path.join(tmp, "fixture-block.spec.js");
      fs.writeFileSync(
        fixture,
        [
          "/*",
          " * Block-comment header.",
          " * @select-skip-when-head-ref-prefix: cms/",
          " */",
          "const x = 1;",
          "",
        ].join("\n"),
      );
      const d = parseSpecDirectives(fixture);
      expect(d.skipWhenHeadRefPrefix).toEqual(["cms/"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("parseSpecDirectives returns {} when no directives are present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "select-directives-"));
    try {
      const fixture = path.join(tmp, "fixture-empty.spec.js");
      fs.writeFileSync(fixture, "const x = 1;\n");
      const d = parseSpecDirectives(fixture);
      expect(d).toEqual({});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("selectSpecs with headRef='cms/foo' excludes annotated CMS publish-loop specs", () => {
    // Use an admin/ change so non-annotated specs also hit the rule
    // pass (otherwise filtering away the publish-loop specs collapses
    // the result to baseline-only → scope=skip, which is the correct
    // but less interesting outcome — see the next test).
    //
    // Pin lane=real so the publish-loop @lane:real specs ARE in play
    // pre-directive — that's the only state in which the directive
    // pass can drop them. (On lane=local they're already filtered
    // out by the lane filter, with no skippedByDirective entry.)
    const r = selectSpecs(["admin/index.html"], {
      headRef: "cms/foo",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).not.toContain("e2e/cms-publish-loop.spec.js");
    expect(r.files).not.toContain("e2e/cms-publish-loop-preview.spec.js");
    expect(r.files).not.toContain("e2e/cms-publish-loop-prod-mutate.spec.js");
    expect(r.files).not.toContain("e2e/cms-delete-published.spec.js");
    // admin-bundle-parity is also @lane:real and survives the rule pass.
    expect(r.files).toContain("e2e/admin-bundle-parity.spec.js");
    // cms-smoke is @lane:local — won't appear on a real-lane subset.
    expect(r.files).not.toContain("e2e/cms-smoke.spec.js");
    // Traceability output records what got dropped.
    expect(Array.isArray(r.skippedByDirective)).toBe(true);
    expect(r.skippedByDirective).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.skippedByDirective).toContain("e2e/cms-delete-published.spec.js");
  });

  test("cms/* head ref + canary-only changeset collapses to skip after directive filtering", () => {
    // Editing only `_e2e/canary-post.md` matches the publish-loop +
    // delete + canary-content specs. canary-content.test.js is in
    // ALWAYS_RUN and stays; the publish-loop specs are filtered out
    // by the directive. Result: only baseline remains → scope=skip,
    // which is exactly the outcome we want for this PR-shape on a
    // cms/* branch (the publish-loop workflow runs them nightly).
    const r = selectSpecs(["_e2e/canary-post.md"], { headRef: "cms/foo" });
    expect(r.scope).toBe("skip");
  });

  test("selectSpecs with headRef='cms/foo' also excludes cms-delete-published spec", () => {
    // admin/ change selects cms-delete-published.spec.js; the directive
    // takes it back out on cms/* head refs. Pin lane=real so the spec
    // is in play pre-directive — see the previous test for rationale.
    const r = selectSpecs(["admin/index.html"], {
      headRef: "cms/foo",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).not.toContain("e2e/cms-delete-published.spec.js");
    expect(r.files).not.toContain("e2e/cms-publish-loop.spec.js");
    // admin-bundle-parity carries no head-ref-prefix directive, so it
    // stays for both lane filters.
    expect(r.files).toContain("e2e/admin-bundle-parity.spec.js");
  });

  test("selectSpecs with headRef='main' includes annotated specs", () => {
    // Non-cms head ref (e.g. a maintenance branch off main) → directive
    // doesn't fire. Pin lane=real so the publish-loop @lane:real specs
    // are in play.
    const r = selectSpecs(["_e2e/canary-post.md"], {
      headRef: "main",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.files).toContain("e2e/cms-publish-loop-preview.spec.js");
    expect(r.skippedByDirective).toBeUndefined();
  });

  test("selectSpecs with empty headRef includes annotated specs (cron / dispatch)", () => {
    // GITHUB_HEAD_REF is empty for `schedule` and `workflow_dispatch`;
    // the selector treats empty as "no filtering" so cron runs still
    // get full coverage of the annotated specs. Pin lane=real for the
    // same reason as the previous test.
    const r = selectSpecs(["_e2e/canary-post.md"], {
      headRef: "",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.skippedByDirective).toBeUndefined();
  });

  test("selectSpecs without headRef option falls back to GITHUB_HEAD_REF env var", () => {
    // The CLI block at the bottom of select-specs.js wires
    // process.env.GITHUB_HEAD_REF as the headRef option, but for
    // library callers the same fallback applies when the option is
    // omitted entirely. Pin lane=real so the publish-loop specs are
    // in play before the directive filter runs.
    const prev = process.env.GITHUB_HEAD_REF;
    try {
      process.env.GITHUB_HEAD_REF = "cms/some-branch";
      const r = selectSpecs(["admin/index.html"], { lane: "real" });
      expect(r.scope).toBe("subset");
      expect(r.files).not.toContain("e2e/cms-publish-loop.spec.js");
      expect(r.files).not.toContain("e2e/cms-delete-published.spec.js");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_HEAD_REF;
      else process.env.GITHUB_HEAD_REF = prev;
    }
  });

  test("selectSpecs without headRef option and no env var includes annotated specs", () => {
    const prev = process.env.GITHUB_HEAD_REF;
    try {
      delete process.env.GITHUB_HEAD_REF;
      const r = selectSpecs(["admin/index.html"], { lane: "real" });
      expect(r.scope).toBe("subset");
      expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
      expect(r.files).toContain("e2e/cms-delete-published.spec.js");
    } finally {
      if (prev === undefined) delete process.env.GITHUB_HEAD_REF;
      else process.env.GITHUB_HEAD_REF = prev;
    }
  });

  test("selectSpecs with headRef='dependabot/foo' (unmatched prefix) keeps cms-only directives", () => {
    // Annotated specs only declare `cms/`; a dependabot/* head ref
    // shouldn't accidentally drop them. Pin lane=real for the same
    // reason as the previous tests.
    const r = selectSpecs(["_e2e/canary-post.md"], {
      headRef: "dependabot/npm/playwright-1.60",
      lane: "real",
    });
    expect(r.scope).toBe("subset");
    expect(r.files).toContain("e2e/cms-publish-loop.spec.js");
    expect(r.skippedByDirective).toBeUndefined();
  });

  test("ALWAYS_RUN baseline is exempt from directive filtering", () => {
    // Even on a cms/* head ref, the baseline survives — those tests
    // are tiny and the directive only filters rule-matched specs.
    // Use admin/ so non-baseline rule-matched specs survive too,
    // keeping scope=subset (otherwise the baseline-only collapse
    // converts to skip).
    const r = selectSpecs(["admin/index.html"], { headRef: "cms/foo" });
    expect(r.scope).toBe("subset");
    for (const a of ALWAYS_RUN) expect(r.files).toContain(a);
  });
});

// Layer 2: shard-count heuristic. The matrix size scales with the
// subset's *light* (non-HEAVY) browser-spec count — heavy specs are
// excluded from the budget because they self-skip on PR runs and don't
// actually consume browser time. Required check `e2e (1)` is preserved
// because shard_count never returns 0 (skip → 1 is the floor) and the
// workflow always builds [1..shard_count].
test.describe("pickShardCount", () => {
  test("skip scope → 1 shard", () => {
    expect(pickShardCount("skip", undefined)).toBe(1);
    expect(pickShardCount("skip", [])).toBe(1);
  });

  test("all scope → 4 shards (full matrix)", () => {
    expect(pickShardCount("all", undefined)).toBe(4);
    expect(pickShardCount("all", [])).toBe(4);
  });

  test("subset with 0-2 browser specs → 1 shard", () => {
    expect(pickShardCount("subset", [])).toBe(1);
    expect(pickShardCount("subset", ["e2e/blog-post.spec.js"])).toBe(1);
    expect(pickShardCount("subset", ["e2e/blog-post.spec.js", "e2e/tags.spec.js"])).toBe(1);
  });

  test("subset with 3-6 browser specs → 2 shards", () => {
    expect(
      pickShardCount("subset", [
        "e2e/blog-post.spec.js",
        "e2e/tags.spec.js",
        "e2e/cms-smoke.spec.js",
      ]),
    ).toBe(2);
    expect(
      pickShardCount("subset", [
        "e2e/blog-post.spec.js",
        "e2e/tags.spec.js",
        "e2e/cms-smoke.spec.js",
        "e2e/cms-editorial-workflow.spec.js",
        "e2e/cms-preview-url.spec.js",
        "e2e/visual-regression.spec.js",
      ]),
    ).toBe(2);
  });

  test("subset with 7+ browser specs → 4 shards (full matrix)", () => {
    expect(
      pickShardCount("subset", [
        "e2e/blog-post.spec.js",
        "e2e/tags.spec.js",
        "e2e/cms-smoke.spec.js",
        "e2e/cms-editorial-workflow.spec.js",
        "e2e/cms-preview-url.spec.js",
        "e2e/visual-regression.spec.js",
        "e2e/cms-publish-flow.spec.js",
      ]),
    ).toBe(4);
  });

  test("non-spec files in the list don't count toward shard budget", () => {
    // Always-run baseline includes .test.js entries — pure-node
    // invariants, no browser. They don't justify extra shards.
    expect(
      pickShardCount("subset", [
        "e2e/compute-visual-diffs.test.js",
        "e2e/canary-content.test.js",
        "e2e/cms-config.spec.js",
        "e2e/visual-change-guard.spec.js",
      ]),
    ).toBe(1);
  });

  test("subset with 5 HEAVY specs + 0 light → 1 shard (HEAVY excluded)", () => {
    // Constructed to exceed the 7+ threshold if HEAVY weren't excluded.
    const all = [
      ...HEAVY,
      // HEAVY only has 4 entries; pad to 5 by repeating (Set keeps
      // it deduped, so the actual file count is still 4 — but the
      // intent of the contract test is "even if every spec is HEAVY,
      // we still scale down").
      "e2e/cms-publish-loop.spec.js",
    ];
    expect(pickShardCount("subset", all)).toBe(1);
  });

  test("subset with 2 HEAVY + 1 light → 1 shard (1 light is in 0-2 bucket)", () => {
    expect(
      pickShardCount("subset", [
        "e2e/cms-publish-loop.spec.js",
        "e2e/cms-publish-loop-preview.spec.js",
        "e2e/blog-post.spec.js",
      ]),
    ).toBe(1);
  });

  test("mixed: 2 HEAVY + 4 light → 2 shards (only light counts)", () => {
    expect(
      pickShardCount("subset", [
        "e2e/cms-publish-loop.spec.js",
        "e2e/cms-publish-loop-preview.spec.js",
        "e2e/blog-post.spec.js",
        "e2e/tags.spec.js",
        "e2e/cms-smoke.spec.js",
        "e2e/cms-editorial-workflow.spec.js",
      ]),
    ).toBe(2);
  });

  test("required-check safety: shard_count is never 0", () => {
    // The required GitHub check is `e2e (1)`. The workflow turns
    // shard_count=N into [1..N], so as long as N >= 1, shard 1
    // always fires. Guard the floor here.
    expect(pickShardCount("skip", [])).toBeGreaterThanOrEqual(1);
    expect(pickShardCount("subset", [])).toBeGreaterThanOrEqual(1);
    expect(pickShardCount("all", [])).toBeGreaterThanOrEqual(1);
    // Even an unknown scope falls through to 4, never 0.
    expect(pickShardCount("garbage", [])).toBeGreaterThanOrEqual(1);
  });
});

test.describe("selectParityPreviewSpecs — render-only fanout (#1723 follow-up)", () => {
  test("FANOUT_PATTERNS is exactly RENDER + TEST_INFRA, render first (main selector unchanged)", () => {
    // The local-matrix selector still fans out on BOTH sets; the split
    // must not drop or reorder a pattern (the 'first fanout file' reason
    // string in selectSpecs depends on the order).
    expect(FANOUT_PATTERNS.map(String)).toEqual(
      [...RENDER_FANOUT_PATTERNS, ...TEST_INFRA_FANOUT_PATTERNS].map(String),
    );
    // The render set must NOT contain any of the test-infra patterns.
    const renderStr = RENDER_FANOUT_PATTERNS.map(String);
    for (const p of TEST_INFRA_FANOUT_PATTERNS.map(String)) {
      expect(renderStr).not.toContain(p);
    }
  });

  test("render-affecting change fans out to ALL parity-preview specs", () => {
    for (const f of ["_layouts/post.html", "_config.yml", "assets/css/main.css", "Gemfile.lock"]) {
      expect(
        selectParityPreviewSpecs([f]).sort(),
        `${f} should select every parity-preview spec (it changes the rendered tree)`,
      ).toEqual([...PARITY_PREVIEW_SPECS].sort());
    }
  });

  test("test/CI-infra change selects NO parity-preview spec (no preview to probe)", () => {
    // These are exactly the files that (a) don't change the deployed
    // site and (b) deploy-preview path-ignores, so no preview exists.
    // Forcing parity-preview here was the spurious-hard-fail bug.
    for (const f of [
      ".github/workflows/e2e-tests.yml",
      "package-lock.json",
      "package.json",
      "playwright.config.js",
      "playwright.regression.config.js",
      "e2e/base.js",
      "e2e/fixture-baseline.js",
      "e2e/fixture-baseline.test.js",
    ]) {
      expect(
        selectParityPreviewSpecs([f]),
        `${f} must NOT select any parity-preview spec — it changes no deployed output`,
      ).toEqual([]);
    }
  });

  test("a parity-preview spec's OWN file change selects NOTHING (probe-less, #1815)", () => {
    // PROBE-LESS: bare-editing a @parity-preview spec deploys no
    // preview (e2e/** is in deploy-preview's paths-ignore), so it must
    // NOT demand a parity-preview probe — that's the ~20-min hard-fail
    // this fix removes. The spec still runs in the normal e2e matrix
    // (selectSpecs' direct-edit rule); we only drop its *preview* probe.
    expect(selectParityPreviewSpecs(["e2e/sitemap.spec.js"])).toEqual([]);
    // selectSpecs (the e2e-matrix selector) is UNCHANGED — the edited
    // spec still runs there.
    expect(selectSpecs(["e2e/sitemap.spec.js"]).files).toContain("e2e/sitemap.spec.js");
  });

  test("a SPEC_RULES test-helper (e2e/public-content.js) selects NO parity-preview spec (#1815)", () => {
    // e2e/public-content.js is a SPEC_RULES trigger for sitemap /
    // console-clean / image-alt-text, but it's test code under
    // deploy-preview's e2e/** paths-ignore — it deploys no preview, so
    // it must not force a parity-preview probe.
    expect(selectParityPreviewSpecs(["e2e/public-content.js"])).toEqual([]);
  });

  test("a deployed-content change (_posts/) DOES still select the relevant parity specs", () => {
    // _posts/ IS deployed (and triggers deploy-preview), so the posts-
    // driven parity-preview specs must still be selected.
    const selected = selectParityPreviewSpecs(["_posts/2024-01-01-x.md"]);
    expect(selected).toContain("e2e/sitemap.spec.js");
    expect(selected).toContain("e2e/console-clean.spec.js");
    expect(selected).toContain("e2e/image-alt-text.spec.js");
  });

  test("admin/ change still selects admin-bundle-parity via its SPEC_RULE (deployed surface)", () => {
    // admin/ IS deployed, so admin-bundle-parity must still run — and
    // admin/ triggers deploy-preview, so a preview will exist.
    expect(selectParityPreviewSpecs(["admin/index.html"])).toContain(
      "e2e/admin-bundle-parity.spec.js",
    );
  });

  test("a mixed render + test-infra change still fans out (render wins)", () => {
    expect(selectParityPreviewSpecs(["_layouts/post.html", "e2e/base.js"]).sort()).toEqual(
      [...PARITY_PREVIEW_SPECS].sort(),
    );
  });
});
