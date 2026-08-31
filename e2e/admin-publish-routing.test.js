// @lane: local — pure-Node sandbox unit tests for the two publish-path route matchers
/*
 * The route matchers behind phases 2 and 4 of the publishing-UX staged plan
 * (docs/PUBLISHING-UX.md §4), exercised with no browser and no network.
 *
 * WHY THESE TWO FUNCTIONS SPECIFICALLY
 * Both shims are otherwise all DOM and REST, and neither has a served surface
 * a browser spec in this suite could drive — they load on the PRODUCTION
 * shell only, because index-test.html must keep exercising Decap's own Status
 * control and board and index-local.html has no editorial workflow at all
 * (each shim's header states this; e2e/admin-publishing-ux.test.js asserts
 * it). What IS testable is the part most likely to break: two pure string
 * matchers that a Decap router or branch-naming change would move.
 *
 *   one-door-publish.js  isWorkflowHash / isWorkflowHref
 *       Too WIDE and it hides an unrelated link or bounces an editor off a
 *       route they asked for. Too NARROW and the Workflow board — the surface
 *       carrying the publish rule that CONTRADICTS the entry editor's
 *       (§2.1) — stays reachable, and phase 2 has quietly not shipped.
 *
 *   publish-progress.js  matchesEntry / branchFor
 *       This one is asymmetric in a way worth writing down. A false NEGATIVE
 *       means "no open PR", which the status model reads as LIVE — telling an
 *       editor a draft is already on the website. A false positive attaches
 *       the wrong PR's progress to an entry. The first is much worse, which
 *       is why the matcher has a lenient tail fallback and why these tests
 *       pin both directions.
 *
 * Loaded in a vm sandbox, the pattern oauth-app-restriction-detector.test.js
 * established.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");

function loadOneDoor() {
  const src = fs.readFileSync(path.join(ADMIN, "one-door-publish.js"), "utf8");
  // A document stub that satisfies the registration code without doing
  // anything: readyState is not "loading", querySelectorAll finds nothing,
  // and MutationObserver is absent so the try/catch takes its no-op branch.
  const sandbox = {
    window: { addEventListener() {} },
    document: {
      readyState: "complete",
      documentElement: {},
      addEventListener() {},
      querySelectorAll: () => [],
    },
    location: { hash: "", pathname: "/admin/", search: "" },
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.__oneDoorPublish;
  expect(api && api.installed, "one-door-publish.js must export window.__oneDoorPublish").toBe(
    true,
  );
  return api;
}

function loadProgress() {
  const src = fs.readFileSync(path.join(ADMIN, "publish-progress.js"), "utf8");
  const sandbox = {
    window: { CMS_REPO: "owner/repo", addEventListener() {} },
    document: {
      // hidden:true makes the first tick return before any fetch — the budget
      // guard doing exactly what it is there for.
      hidden: true,
      readyState: "complete",
      addEventListener() {},
    },
    location: { hash: "" },
    localStorage: { getItem: () => null },
    setInterval: () => 0,
    fetch: () => Promise.reject(new Error("no network in this sandbox")),
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.CMSPublishProgress;
  expect(api && typeof api, "publish-progress.js must export window.CMSPublishProgress").toBe(
    "object",
  );
  return { api, sandbox };
}

test.describe("one-door-publish — the Workflow route matchers", () => {
  test("matches the board's own hash forms", () => {
    const { isWorkflowHash } = loadOneDoor();
    for (const h of ["#/workflow", "#/workflow/", "#/workflow/posts/x", "/workflow"]) {
      expect(isWorkflowHash(h), `${h} should be the workflow route`).toBe(true);
    }
  });

  test("does NOT match a collection that merely contains the word", () => {
    const { isWorkflowHash } = loadOneDoor();
    // A site is entirely free to name a collection "workflow", and an editor
    // bounced out of their own collection would be a far worse bug than the
    // one phase 2 fixes.
    for (const h of [
      "#/collections/workflow",
      "#/collections/workflows/entries/a",
      "#/collections/posts/entries/my-workflow",
      "#/",
      "",
    ]) {
      expect(isWorkflowHash(h), `${h} must NOT be treated as the workflow route`).toBe(false);
    }
  });

  test("reads an anchor href in every form Decap's router emits", () => {
    const { isWorkflowHref } = loadOneDoor();
    for (const h of [
      "#/workflow",
      "#/workflow/",
      "https://example.test/admin/#/workflow",
      "/workflow",
    ]) {
      expect(isWorkflowHref(h), `${h} should be a workflow link`).toBe(true);
    }
    for (const h of ["#/collections/posts", "#/workflowish", "/workflows", "", null]) {
      expect(isWorkflowHref(h), `${h} must NOT be a workflow link`).toBe(false);
    }
  });
});

test.describe("publish-progress — entry route and branch matching", () => {
  test("reads the entry out of Decap's own hash route", () => {
    const { api, sandbox } = loadProgress();
    sandbox.location.hash = "#/collections/posts/entries/2026-04-25-a-post";
    expect(api.currentEntry()).toEqual({ collection: "posts", slug: "2026-04-25-a-post" });
  });

  test("a NEW entry has no branch yet, so it is not an entry for polling", () => {
    const { api, sandbox } = loadProgress();
    // `/new` has no PR and no head ref. Treating it as an entry would send a
    // PR lookup after a branch that cannot exist.
    for (const h of ["#/collections/posts/new", "#/collections/posts", "#/workflow", ""]) {
      sandbox.location.hash = h;
      expect(api.currentEntry(), `${h} must not resolve to an entry`).toBeNull();
    }
  });

  test("builds the cms/<collection>/<slug> branch Decap actually creates", () => {
    const { api } = loadProgress();
    expect(api.branchFor({ collection: "posts", slug: "a-post" })).toBe("cms/posts/a-post");
  });

  test("matches the entry's own PR and rejects another entry's", () => {
    const { api } = loadProgress();
    const entry = { collection: "posts", slug: "a-post" };
    expect(api.matchesEntry("cms/posts/a-post", entry)).toBe(true);
    expect(api.matchesEntry("cms/posts/another-post", entry)).toBe(false);
    expect(api.matchesEntry("cms/pages/a-post", entry)).toBe(false);
    expect(api.matchesEntry("", entry)).toBe(false);
    expect(api.matchesEntry(null, entry)).toBe(false);
  });

  // The asymmetry from this file's header, made concrete. Decap sanitizes
  // some slugs on the way into a branch name, and an exact-compare-only
  // matcher would answer "no open PR" for an entry that has one — which the
  // status model reads as LIVE. Erring toward matching is the safe direction.
  test("a sanitized branch still matches, because the wrong answer here says Live", () => {
    const { api } = loadProgress();
    const entry = { collection: "posts", slug: "a-post" };
    expect(api.matchesEntry("cms/posts/prefix-a-post", entry)).toBe(true);
  });
});
