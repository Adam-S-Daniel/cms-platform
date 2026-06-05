// @lane: local — pure unit test for the recursion-gate decision logic
/*
 * Locks the cms-recursion-gate contract (see
 * .github/actions/cms-recursion-gate + e2e/cms-recursion-churn.js):
 *
 *   - a push whose every changed file ∈ a loop's self-churn set is the
 *     loop feeding itself ⇒ SKIP (shouldRunLoop → false);
 *   - any non-self-churn path ⇒ RUN (true);
 *   - the throw-away transient globs match run-id-suffixed names;
 *   - every loop spec's FIXTURE_PATH is actually covered (cross-check
 *     so the map can't silently drift from the specs).
 *
 * Same ethos as canary-content.test.js: make the invariant fail loud
 * at CI time instead of regressing silently in a workflow edit.
 */
const { test, expect } = require("./base");
const {
  SELF_CHURN,
  shouldRunLoop,
  isSelfChurn,
  isBumpArtifact,
  isBumpOnlyPush,
} = require("./cms-recursion-churn");
const { CANARIES } = require("./canary-content");

// The literal each loop spec churns to `main`. Kept here (not imported
// from the specs — they pull in Playwright/network helpers) so a spec
// renaming its fixture without updating SELF_CHURN trips this test.
const SPEC_FIXTURES = {
  host: [
    ...CANARIES.map((c) => c.path), // cms-publish-loop.spec.js
    "_e2e/canary-delete-1779206766920.md", // cms-delete-published.spec.js (runId-suffixed)
    "_posts/2024-01-02-e2e-unpublish-canary.md", // cms-unpublish-republish.spec.js
    "_tags/e2e-tags-canary-1779206559297.md", // cms-tags-lifecycle.spec.js (runId-suffixed)
  ],
  media: [
    "_posts/2099-12-31-e2e-media-roundtrip-1779206766920.md", // ephemeral per-run post (runId-suffixed)
    "assets/images/uploads/e2e-media-roundtrip-1779206766920.png", // throw-away upload
  ],
  prod: [
    "_posts/2099-12-31-e2e-prod-mutate-1779206766920.md", // ephemeral per-run post (runId-suffixed)
  ],
};

test.describe("cms-recursion-churn decision logic", () => {
  test.describe.configure({ mode: "serial" });

  test("every loop spec's churned fixture is in its self-churn set", () => {
    for (const [loop, fixtures] of Object.entries(SPEC_FIXTURES)) {
      for (const f of fixtures) {
        expect(
          isSelfChurn(loop, f),
          `${loop}: ${f} must be covered by SELF_CHURN.${loop} — a spec churns it to main and the loop would re-fire on its own merge without this`,
        ).toBe(true);
      }
    }
  });

  test("a push that ONLY churned the loop's own fixtures is skipped", () => {
    for (const [loop, fixtures] of Object.entries(SPEC_FIXTURES)) {
      // Whole set, and each singly — every subset is the loop feeding
      // itself, so none should run.
      expect(
        shouldRunLoop(loop, fixtures),
        `${loop}: a push of only self-churn files must SKIP`,
      ).toBe(false);
      for (const f of fixtures) {
        expect(shouldRunLoop(loop, [f]), `${loop}: [${f}] must SKIP`).toBe(false);
      }
    }
  });

  test("any non-self-churn path forces a run (even mixed with churn)", () => {
    const realChanges = [
      ".github/workflows/cms-publish-loop-host.yml",
      "e2e/cms-publish-loop.spec.js",
      "admin/config.yml",
      "_posts/2026-05-19-a-real-post.md",
      "package-lock.json",
    ];
    for (const loop of Object.keys(SELF_CHURN)) {
      for (const real of realChanges) {
        expect(shouldRunLoop(loop, [real]), `${loop}: [${real}] must RUN`).toBe(true);
        // Mixed: a real machinery change rides alongside canary churn.
        expect(
          shouldRunLoop(loop, [...SPEC_FIXTURES[loop], real]),
          `${loop}: churn + ${real} must RUN (don't skip a real change hiding behind canary churn)`,
        ).toBe(true);
      }
    }
  });

  test("transient globs are segment-anchored (no cross-directory / cross-segment match)", () => {
    // `*` must not swallow a `/`.
    expect(isSelfChurn("host", "_e2e/canary-delete-1.md")).toBe(true);
    expect(isSelfChurn("host", "_e2e/sub/canary-delete-1.md")).toBe(false);
    expect(isSelfChurn("host", "_e2e/canary-delete-1.md.bak")).toBe(false);
    expect(isSelfChurn("host", "_tags/e2e-tags-canary-9.md")).toBe(true);
    expect(isSelfChurn("host", "_tags/other.md")).toBe(false);
    expect(isSelfChurn("media", "assets/images/uploads/e2e-media-roundtrip-9.png")).toBe(true);
    expect(isSelfChurn("media", "assets/images/uploads/nested/x-9.png")).toBe(false);
    // A host fixture is not a media/prod fixture (sets are disjoint).
    expect(isSelfChurn("prod", "_posts/2024-01-02-e2e-unpublish-canary.md")).toBe(false);
  });

  // ── platform-version bump-only skip (the jodidaniel host-loop reflect-race) ──
  test("a platform-version-bump-only push is SKIPPED for every loop", () => {
    // A bump rewrites platform.lock + the @ref pins (workflows) + the gem tag.
    const bump = [
      "platform.lock",
      ".github/workflows/cms-publish-loop-host.yml",
      ".github/workflows/deploy-production.yml",
      "Gemfile",
      "Gemfile.lock",
    ];
    expect(isBumpOnlyPush(bump), "platform.lock + only bump artifacts ⇒ bump-only").toBe(true);
    for (const loop of Object.keys(SELF_CHURN)) {
      expect(shouldRunLoop(loop, bump), `${loop}: a version-bump-only push must SKIP`).toBe(false);
    }
  });

  test("a bump mixed with a real machinery change still RUNS", () => {
    const mixed = ["platform.lock", "Gemfile.lock", "admin/config.yml"];
    expect(isBumpOnlyPush(mixed)).toBe(false);
    for (const loop of Object.keys(SELF_CHURN)) {
      expect(shouldRunLoop(loop, mixed), `${loop}: bump + admin change must RUN`).toBe(true);
    }
  });

  test("a workflow-LOGIC edit (no platform.lock) is NOT treated as a bump — RUNS", () => {
    // No platform.lock ⇒ not a bump; a real change to a loop's own workflow must
    // still run so its behaviour is validated.
    const logicEdit = [".github/workflows/cms-publish-loop-host.yml"];
    expect(isBumpOnlyPush(logicEdit)).toBe(false);
    for (const loop of Object.keys(SELF_CHURN)) {
      expect(shouldRunLoop(loop, logicEdit), `${loop}: workflow-logic edit must RUN`).toBe(true);
    }
    // Gemfile alone (no platform.lock) is likewise not a bump.
    expect(isBumpOnlyPush(["Gemfile"])).toBe(false);
  });

  test("isBumpArtifact classifies pins vs content", () => {
    for (const p of ["platform.lock", "Gemfile", "Gemfile.lock", ".github/workflows/x.yml", ".github/workflows/x.yaml"]) {
      expect(isBumpArtifact(p), `${p} is a bump artifact`).toBe(true);
    }
    for (const p of ["admin/config.yml", "_config.yml", "_layouts/post.html", ".github/actions/x/action.yml", "README.md"]) {
      expect(isBumpArtifact(p), `${p} is NOT a bump artifact`).toBe(false);
    }
  });

  test("guards: unknown loop and empty/invalid changed set throw", () => {
    expect(() => shouldRunLoop("nope", ["x"])).toThrow(/Unknown loop/);
    expect(() => isSelfChurn("nope", "x")).toThrow(/Unknown loop/);
    expect(() => shouldRunLoop("host", [])).toThrow(/non-empty array/);
    expect(() => shouldRunLoop("host", null)).toThrow(/non-empty array/);
  });

  test("SELF_CHURN keys match the three real-prod loop keys exactly", () => {
    expect(Object.keys(SELF_CHURN).sort()).toEqual(["host", "media", "prod"]);
  });
});
