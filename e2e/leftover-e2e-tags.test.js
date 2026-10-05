// @lane: local — pure logic with injected fakes, no network: the #689
// leftover-e2e-tag sweep (e2e/leftover-e2e-tags.js) and the tags specs'
// in-flight create-PR close (cms-fixture-pr.js closeOpenPrsAddingFile), plus
// an AST lint over the two tags spec sources (harness-internal, so this file
// is registered in PLATFORM_META_SPECS).
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { parse, calleeName } = require("./spec-ast");
const { test, expect } = require("./base");
const { classifyE2eTags, sweepLeftoverE2eTags, STALE_AFTER_MS } = require("./leftover-e2e-tags");
const { closeOpenPrsAddingFile } = require("./cms-fixture-pr");

const NOW = 1790000000000;
const OLD = NOW - STALE_AFTER_MS - 1;
const YOUNG = NOW - 60 * 1000;
const file = (name) => ({ type: "file", name });

function httpError(status) {
  const e = new Error(`GitHub API ${status}`);
  e.status = status;
  return e;
}

// A fake gh(): `routes` maps "METHOD path" to a value or a function; an
// unrouted call fails the test. Every call is recorded.
function fakeGh(routes) {
  const calls = [];
  const impl = async (p, init = {}) => {
    const key = `${init.method || "GET"} ${p}`;
    calls.push(key);
    if (!(key in routes)) throw new Error(`unexpected call: ${key}`);
    const r = routes[key];
    return typeof r === "function" ? r() : r;
  };
  return { impl, calls };
}

test.describe("classifyE2eTags (#689)", () => {
  test("splits stale canaries, fresh canaries and other e2e tags; ignores real tags", () => {
    const res = classifyE2eTags(
      [
        file(`e2e-tags-canary-${OLD}.md`),
        file(`e2e-tags-canary-preview-${OLD}.md`),
        file(`e2e-tags-canary-${YOUNG}.md`),
        file("e2e-hand-made.md"),
        file("jekyll.md"),
        { type: "dir", name: "e2e-dir" },
      ],
      NOW,
    );
    expect(res.stale).toEqual([
      `_tags/e2e-tags-canary-${OLD}.md`,
      `_tags/e2e-tags-canary-preview-${OLD}.md`,
    ]);
    expect(res.fresh).toEqual([`_tags/e2e-tags-canary-${YOUNG}.md`]);
    expect(res.other).toEqual(["_tags/e2e-hand-made.md"]);
  });
});

test.describe("sweepLeftoverE2eTags (#689)", () => {
  const LIST = "GET /repos/o/r/contents/_tags?ref=main";
  const PULLS = "GET /repos/o/r/pulls?state=open&base=main&per_page=100";

  test("a site with no _tags directory has nothing left over", async () => {
    const gh = fakeGh({ [LIST]: () => Promise.reject(httpError(404)) });
    const removed = [];
    const res = await sweepLeftoverE2eTags({
      repo: "o/r",
      ghImpl: gh.impl,
      removeImpl: async (a) => removed.push(a),
      nowMs: NOW,
      log: () => {},
    });
    expect(res.leftover).toBe(0);
    expect(removed).toEqual([]);
  });

  test("a non-404 listing error throws instead of reading clean", async () => {
    const gh = fakeGh({ [LIST]: () => Promise.reject(httpError(500)) });
    await expect(
      sweepLeftoverE2eTags({
        repo: "o/r",
        ghImpl: gh.impl,
        removeImpl: async () => {},
        nowMs: NOW,
        log: () => {},
      }),
    ).rejects.toThrow("500");
  });

  test("removes only stale canaries, reports other e2e tags, leaves fresh ones", async () => {
    const gh = fakeGh({
      [LIST]: [
        file(`e2e-tags-canary-${OLD}.md`),
        file(`e2e-tags-canary-${YOUNG}.md`),
        file("e2e-hand-made.md"),
        file("ruby.md"),
      ],
      [PULLS]: [],
    });
    const removed = [];
    const res = await sweepLeftoverE2eTags({
      repo: "o/r",
      ghImpl: gh.impl,
      removeImpl: async (a) => removed.push(a),
      nowMs: NOW,
      log: () => {},
    });
    expect(removed.map((a) => a.filePath)).toEqual([`_tags/e2e-tags-canary-${OLD}.md`]);
    expect(removed[0].slug).toBe(`e2e-tags-canary-${OLD}`);
    expect(removed[0].skipWaitForMerge).toBe(true);
    expect(res.leftover).toBe(2);
    expect(res.removed).toEqual([`_tags/e2e-tags-canary-${OLD}.md`]);
  });

  test("does not open a second removal PR while one is open, but still reports it", async () => {
    const gh = fakeGh({
      [LIST]: [file(`e2e-tags-canary-${OLD}.md`)],
      [PULLS]: [{ number: 7, head: { ref: `cms/e2e-fixture/remove-e2e-tags-canary-${OLD}-x` } }],
    });
    const removed = [];
    const res = await sweepLeftoverE2eTags({
      repo: "o/r",
      ghImpl: gh.impl,
      removeImpl: async (a) => removed.push(a),
      nowMs: NOW,
      log: () => {},
    });
    expect(removed).toEqual([]);
    expect(res.leftover).toBe(1);
  });

  test("a failed removal throws", async () => {
    const gh = fakeGh({ [LIST]: [file(`e2e-tags-canary-${OLD}.md`)], [PULLS]: [] });
    await expect(
      sweepLeftoverE2eTags({
        repo: "o/r",
        ghImpl: gh.impl,
        removeImpl: async () => {
          throw httpError(422);
        },
        nowMs: NOW,
        log: () => {},
      }),
    ).rejects.toThrow("422");
  });
});

test.describe("closeOpenPrsAddingFile (#689)", () => {
  const FILE = "_tags/e2e-tags-canary-1786027176024.md";
  const LIST = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1";

  test("closes this run's open create PR and deletes its branch", async () => {
    let state = "open";
    const gh = fakeGh({
      [LIST]: [
        { number: 2938, head: { ref: "cms/tags/e2e-tags-canary-1786027176024" } },
        { number: 5, head: { ref: "cms/posts/real-draft" } },
        { number: 6, head: { ref: "feature/x" } },
      ],
      "GET /repos/o/r/pulls/2938/files?per_page=100": [{ filename: FILE, status: "added" }],
      "GET /repos/o/r/pulls/5/files?per_page=100": [{ filename: "_posts/real.md", status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/2938": () => ({ state, merged: false }),
      "DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-1786027176024": {},
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [2938], merged: [] });
    expect(gh.calls).not.toContain("PATCH /repos/o/r/pulls/5");
    expect(gh.calls).not.toContain("GET /repos/o/r/pulls/6/files?per_page=100");
  });

  test("leaves a PR that only removes the file alone", async () => {
    const gh = fakeGh({
      [LIST]: [{ number: 9, head: { ref: "cms/tags/e2e-tags-canary-1786027176024" } }],
      "GET /repos/o/r/pulls/9/files?per_page=100": [{ filename: FILE, status: "removed" }],
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [], merged: [] });
  });

  test("reports a PR that merged before the close took effect", async () => {
    const gh = fakeGh({
      [LIST]: [{ number: 2938, head: { ref: "cms/tags/e2e-tags-canary-1786027176024" } }],
      "GET /repos/o/r/pulls/2938/files?per_page=100": [{ filename: FILE, status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => Promise.reject(httpError(422)),
      "GET /repos/o/r/pulls/2938": { state: "closed", merged: true },
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [], merged: [2938] });
  });

  test("throws when the PR is still open after the close", async () => {
    const gh = fakeGh({
      [LIST]: [{ number: 2938, head: { ref: "cms/tags/e2e-tags-canary-1786027176024" } }],
      "GET /repos/o/r/pulls/2938/files?per_page=100": [{ filename: FILE, status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => Promise.reject(httpError(403)),
      "GET /repos/o/r/pulls/2938": { state: "open", merged: false },
    });
    await expect(
      closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl }),
    ).rejects.toThrow("still open");
  });

  test("throws when the open-PR list cannot be read", async () => {
    const gh = fakeGh({ [LIST]: () => Promise.reject(httpError(502)) });
    await expect(
      closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl }),
    ).rejects.toThrow("502");
  });
});

// The safety net must stop the in-flight PR BEFORE it reads the canary's
// ref; the reverse order is the #689 incident (absent on main, PR still open).
test.describe("tags specs close the in-flight PR before reading the ref (#689)", () => {
  for (const [spec, readsRef] of [
    ["cms-tags-lifecycle.spec.js", (name) => name === "fileExistsOnMain"],
    ["cms-tags-lifecycle-preview.spec.js", (name) => name === "gh"],
  ]) {
    test(spec, () => {
      const ast = parse(fs.readFileSync(path.join(__dirname, spec), "utf8"));
      const hooks = [];
      walk.simple(ast, {
        CallExpression(n) {
          if (calleeName(n.callee) === "test.afterAll") hooks.push(n.arguments[n.arguments.length - 1]);
        },
      });
      expect(hooks.length, "one afterAll hook").toBe(1);
      let close = null;
      let read = null;
      walk.simple(hooks[0], {
        CallExpression(n) {
          const name = calleeName(n.callee);
          if (name === "closeOpenPrsAddingFile" && (close === null || n.start < close)) close = n.start;
          if (readsRef(name) && (read === null || n.start < read)) read = n.start;
        },
      });
      expect(close, "afterAll calls closeOpenPrsAddingFile").not.toBeNull();
      expect(read, "afterAll reads the canary's ref").not.toBeNull();
      expect(close).toBeLessThan(read);
    });
  }
});
