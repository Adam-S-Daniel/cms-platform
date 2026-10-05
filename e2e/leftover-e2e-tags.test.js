// @lane: local — pure logic with injected fakes, no network: the #689
// leftover-e2e-tag sweep (e2e/leftover-e2e-tags.js) and the Decap-created
// fixtures' in-flight create-PR close (cms-fixture-pr.js
// closeOpenPrsAddingFile), plus an AST lint over those spec sources
// (harness-internal, so this file is registered in PLATFORM_META_SPECS).
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { parse, calleeName } = require("./spec-ast");
const { test, expect } = require("./base");
const { classifyE2eTags, sweepLeftoverE2eTags, STALE_AFTER_MS } = require("./leftover-e2e-tags");
const { closeOpenPrsAddingFile, listAllPages, readFileOnRef } = require("./cms-fixture-pr");

const NOW = 1790000000000;
const OLD = NOW - STALE_AFTER_MS - 1;
const YOUNG = NOW - 60 * 1000;
const FUTURE = NOW + 24 * 60 * 60 * 1000;
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
        file(`e2e-tags-canary-${FUTURE}.md`),
        file("e2e-hand-made.md"),
        // Anchor locks: neither is a run-stamped canary name.
        file(`e2e-x-e2e-tags-canary-${OLD}.md`),
        file(`e2e-tags-canary-${OLD}.md.orig`),
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
    expect(res.future).toEqual([`_tags/e2e-tags-canary-${FUTURE}.md`]);
    expect(res.other).toEqual([
      "_tags/e2e-hand-made.md",
      `_tags/e2e-x-e2e-tags-canary-${OLD}.md`,
      `_tags/e2e-tags-canary-${OLD}.md.orig`,
    ]);
  });
});

test.describe("sweepLeftoverE2eTags (#689)", () => {
  const LIST = "GET /repos/o/r/contents/_tags?ref=main";
  const PULLS = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1";

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
        file(`e2e-tags-canary-${FUTURE}.md`),
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
    expect(res.leftover).toBe(3);
    expect(res.future).toEqual([`_tags/e2e-tags-canary-${FUTURE}.md`]);
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
  const ID = "1786027176024";
  const FILE = `_tags/e2e-tags-canary-${ID}.md`;
  const LIST = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1";
  const filesKey = (n) => `GET /repos/o/r/pulls/${n}/files?per_page=100&page=1`;
  const pr = (number, ref, repo = { full_name: "o/r" }) => ({ number, head: { ref, repo } });

  // Open cms/ PRs that are NOT this run's create PR: none may be written to.
  const DISTRACTORS = [
    // another run's canary
    [11, "cms/tags/e2e-tags-canary-1786027999999", "_tags/e2e-tags-canary-1786027999999.md", "added"],
    // a name that has our file name as a prefix
    [12, `cms/tags/e2e-tags-canary-${ID}x`, `_tags/e2e-tags-canary-${ID}x.md`, "added"],
    // the preview spec's canary with the same run id
    [13, `cms/tags/e2e-tags-canary-preview-${ID}`, `_tags/e2e-tags-canary-preview-${ID}.md`, "added"],
    // a PR that only REMOVES our file
    [14, `cms/tags/e2e-tags-canary-${ID}`, FILE, "removed"],
  ];
  const distractorPrs = () => DISTRACTORS.map(([n, ref]) => pr(n, ref));
  const distractorRoutes = () =>
    Object.fromEntries(DISTRACTORS.map(([n, , filename, status]) => [filesKey(n), [{ filename, status }]]));
  const writes = (calls) => calls.filter((c) => !c.startsWith("GET "));

  test("closes only this run's open create PR, never another open cms/ PR", async () => {
    let state = "open";
    const gh = fakeGh({
      [LIST]: [...distractorPrs(), pr(2938, `cms/tags/e2e-tags-canary-${ID}`), pr(5, "cms/posts/real-draft"), pr(6, "feature/x")],
      ...distractorRoutes(),
      [filesKey(2938)]: [{ filename: FILE, status: "added" }],
      [filesKey(5)]: [{ filename: "_posts/real.md", status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/2938": () => ({ state, merged: false }),
      [`DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-${ID}`]: {},
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [2938], merged: [] });
    expect(writes(gh.calls)).toEqual([
      "PATCH /repos/o/r/pulls/2938",
      `DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-${ID}`,
    ]);
    expect(gh.calls).not.toContain(filesKey(6));
  });

  test("with only other cms/ PRs open, nothing is closed", async () => {
    const gh = fakeGh({ [LIST]: distractorPrs(), ...distractorRoutes() });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [], merged: [] });
    expect(writes(gh.calls)).toEqual([]);
  });

  test("the preview spec's call closes only the preview canary PR into the head branch", async () => {
    const PFILE = `_tags/e2e-tags-canary-preview-${ID}.md`;
    let state = "open";
    const gh = fakeGh({
      "GET /repos/o/r/pulls?state=open&base=feature%2Fx&per_page=100&page=1": [
        pr(21, `cms/tags/e2e-tags-canary-${ID}`),
        pr(22, `cms/tags/e2e-tags-canary-preview-${ID}`),
        pr(23, `cms/tags/e2e-tags-canary-preview-${ID}x`),
      ],
      [filesKey(21)]: [{ filename: FILE, status: "added" }],
      [filesKey(22)]: [{ filename: PFILE, status: "added" }],
      [filesKey(23)]: [{ filename: `_tags/e2e-tags-canary-preview-${ID}x.md`, status: "added" }],
      "PATCH /repos/o/r/pulls/22": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/22": () => ({ state, merged: false }),
      [`DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-preview-${ID}`]: {},
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "feature/x", filePath: PFILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [22], merged: [] });
    expect(writes(gh.calls)).toEqual([
      "PATCH /repos/o/r/pulls/22",
      `DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-preview-${ID}`,
    ]);
  });

  test("a closed fork PR is not followed by a branch delete in this repo", async () => {
    const gh = fakeGh({
      [LIST]: [pr(31, `cms/tags/e2e-tags-canary-${ID}`, { full_name: "someone/fork" })],
      [filesKey(31)]: [{ filename: FILE, status: "added" }],
      "PATCH /repos/o/r/pulls/31": {},
      "GET /repos/o/r/pulls/31": { state: "closed", merged: false },
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [31], merged: [] });
    expect(writes(gh.calls)).toEqual(["PATCH /repos/o/r/pulls/31"]);
  });

  test("reads every page of the PR list and of a PR's files, the list before any write", async () => {
    let state = "open";
    const PAGE2 = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=2";
    const gh = fakeGh({
      [LIST]: Array.from({ length: 100 }, (_, i) => pr(1000 + i, `feature/f${i}`)),
      [PAGE2]: [pr(2938, `cms/tags/e2e-tags-canary-${ID}`)],
      [filesKey(2938)]: Array.from({ length: 100 }, (_, i) => ({ filename: `_posts/p${i}.md`, status: "added" })),
      "GET /repos/o/r/pulls/2938/files?per_page=100&page=2": [{ filename: FILE, status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/2938": () => ({ state, merged: false }),
      [`DELETE /repos/o/r/git/refs/heads/cms/tags/e2e-tags-canary-${ID}`]: {},
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [2938], merged: [] });
    expect(gh.calls.indexOf(PAGE2)).toBeLessThan(gh.calls.indexOf("PATCH /repos/o/r/pulls/2938"));
  });

  test("reports a PR that merged before the close took effect", async () => {
    const gh = fakeGh({
      [LIST]: [pr(2938, `cms/tags/e2e-tags-canary-${ID}`)],
      [filesKey(2938)]: [{ filename: FILE, status: "added" }],
      "PATCH /repos/o/r/pulls/2938": () => Promise.reject(httpError(422)),
      "GET /repos/o/r/pulls/2938": { state: "closed", merged: true },
    });
    const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
    expect(res).toEqual({ closed: [], merged: [2938] });
  });

  test("throws when the PR is still open after the close", async () => {
    const gh = fakeGh({
      [LIST]: [pr(2938, `cms/tags/e2e-tags-canary-${ID}`)],
      [filesKey(2938)]: [{ filename: FILE, status: "added" }],
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

  test("a non-array list page throws", async () => {
    await expect(listAllPages(fakeGh({ "GET /x?per_page=100&page=1": { message: "x" } }).impl, "/x")).rejects.toThrow(
      "not an array",
    );
  });
});

// The prod-mutate, delete-published and media round-trip safety nets (#689
// follow-up) pass their own run-stamped paths: only this run's create PR may
// be written to, never another run's fixture, a prefix collision, a sibling
// spec's fixture with the same run id, or the delete leg's removal PR.
test.describe("closeOpenPrsAddingFile with the posts/e2e/media safety-net paths (#689)", () => {
  const ID = "1790000000000";
  const LIST = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1";
  const filesKey = (n) => `GET /repos/o/r/pulls/${n}/files?per_page=100&page=1`;
  const pr = (number, ref) => ({ number, head: { ref, repo: { full_name: "o/r" } } });
  const writes = (calls) => calls.filter((c) => !c.startsWith("GET "));

  // [spec, this run's path, its create branch, distractor [ref, filename, status]...]
  const CASES = [
    [
      "cms-publish-loop-prod-mutate",
      `_posts/2099-12-31-e2e-prod-mutate-${ID}.md`,
      `cms/posts/2099-12-31-e2e-prod-mutate-${ID}`,
      [
        ["cms/posts/2099-12-31-e2e-prod-mutate-1790000099999", "_posts/2099-12-31-e2e-prod-mutate-1790000099999.md", "added"],
        [`cms/posts/2099-12-31-e2e-prod-mutate-${ID}0`, `_posts/2099-12-31-e2e-prod-mutate-${ID}0.md`, "added"],
        [`cms/posts/2099-12-31-e2e-media-roundtrip-${ID}`, `_posts/2099-12-31-e2e-media-roundtrip-${ID}.md`, "added"],
        [`cms/posts/delete-2099-12-31-e2e-prod-mutate-${ID}`, `_posts/2099-12-31-e2e-prod-mutate-${ID}.md`, "removed"],
      ],
    ],
    [
      "cms-delete-published",
      `_e2e/canary-delete-${ID}.md`,
      `cms/e2e/canary-delete-${ID}`,
      [
        ["cms/e2e/canary-delete-1790000099999", "_e2e/canary-delete-1790000099999.md", "added"],
        [`cms/e2e/canary-delete-${ID}0`, `_e2e/canary-delete-${ID}0.md`, "added"],
        [`cms/e2e/canary-${ID}`, `_e2e/canary-${ID}.md`, "added"],
        [`cms/e2e/delete-canary-delete-${ID}`, `_e2e/canary-delete-${ID}.md`, "removed"],
      ],
    ],
  ];
  for (const [spec, FILE, branch, distractors] of CASES) {
    test(`${spec}: closes only this run's create PR`, async () => {
      let state = "open";
      const routes = {
        [LIST]: [...distractors.map(([ref], i) => pr(40 + i, ref)), pr(4000, branch)],
        [filesKey(4000)]: [{ filename: FILE, status: "added" }],
        "PATCH /repos/o/r/pulls/4000": () => {
          state = "closed";
          return {};
        },
        "GET /repos/o/r/pulls/4000": () => ({ state, merged: false }),
        [`DELETE /repos/o/r/git/refs/heads/${branch}`]: {},
      };
      distractors.forEach(([, filename, status], i) => {
        routes[filesKey(40 + i)] = [{ filename, status }];
      });
      const gh = fakeGh(routes);
      const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
      expect(res).toEqual({ closed: [4000], merged: [] });
      expect(writes(gh.calls)).toEqual(["PATCH /repos/o/r/pulls/4000", `DELETE /repos/o/r/git/refs/heads/${branch}`]);
    });

    test(`${spec}: with only foreign PRs open, nothing is written`, async () => {
      const routes = { [LIST]: distractors.map(([ref], i) => pr(40 + i, ref)) };
      distractors.forEach(([, filename, status], i) => {
        routes[filesKey(40 + i)] = [{ filename, status }];
      });
      const gh = fakeGh(routes);
      const res = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: FILE, ghImpl: gh.impl });
      expect(res).toEqual({ closed: [], merged: [] });
      expect(writes(gh.calls)).toEqual([]);
    });
  }

  // The media spec closes by the post path, then by the upload path. Its
  // create PR adds both, so the first call closes it and the second finds it
  // gone from the open list; another run's upload and this run's media-delete
  // PR stay untouched.
  const POST = `_posts/2099-12-31-e2e-media-roundtrip-${ID}.md`;
  const IMAGE = `assets/images/uploads/e2e-media-roundtrip-${ID}.png`;
  const CREATE = `cms/posts/2099-12-31-e2e-media-roundtrip-${ID}`;
  const MEDIA_DISTRACTORS = [
    [51, "cms/posts/2099-12-31-e2e-media-roundtrip-1790000099999", [
      { filename: "_posts/2099-12-31-e2e-media-roundtrip-1790000099999.md", status: "added" },
      { filename: "assets/images/uploads/e2e-media-roundtrip-1790000099999.png", status: "added" },
    ]],
    [52, `cms/media/delete-e2e-media-roundtrip-${ID}`, [{ filename: IMAGE, status: "removed" }]],
    [53, `cms/posts/2099-12-31-e2e-prod-mutate-${ID}`, [
      { filename: `_posts/2099-12-31-e2e-prod-mutate-${ID}.md`, status: "added" },
    ]],
  ];
  const mediaRoutes = (createOpen, extra) => {
    const routes = {
      [LIST]: () => [
        ...MEDIA_DISTRACTORS.map(([n, ref]) => pr(n, ref)),
        ...(createOpen() ? [pr(5000, CREATE)] : []),
        ...extra.map(([n, ref]) => pr(n, ref)),
      ],
    };
    for (const [n, , files] of [...MEDIA_DISTRACTORS, ...extra]) routes[filesKey(n)] = files;
    return routes;
  };

  test("cms-media-roundtrip: one create PR adding post and upload is closed once", async () => {
    let state = "open";
    const gh = fakeGh({
      ...mediaRoutes(() => state === "open", []),
      [filesKey(5000)]: [
        { filename: POST, status: "added" },
        { filename: IMAGE, status: "added" },
      ],
      "PATCH /repos/o/r/pulls/5000": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/5000": () => ({ state, merged: false }),
      [`DELETE /repos/o/r/git/refs/heads/${CREATE}`]: {},
    });
    const first = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: POST, ghImpl: gh.impl });
    const second = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: IMAGE, ghImpl: gh.impl });
    expect(first).toEqual({ closed: [5000], merged: [] });
    expect(second).toEqual({ closed: [], merged: [] });
    expect(writes(gh.calls)).toEqual(["PATCH /repos/o/r/pulls/5000", `DELETE /repos/o/r/git/refs/heads/${CREATE}`]);
  });

  test("cms-media-roundtrip: an upload committed in its own PR is closed by the upload-path call", async () => {
    const UPLOAD = `cms/media/e2e-media-roundtrip-${ID}`;
    let state = "open";
    const gh = fakeGh({
      ...mediaRoutes(() => false, [[5001, UPLOAD, [{ filename: IMAGE, status: "added" }]]]),
      "PATCH /repos/o/r/pulls/5001": () => {
        state = "closed";
        return {};
      },
      "GET /repos/o/r/pulls/5001": () => ({ state, merged: false }),
      [`DELETE /repos/o/r/git/refs/heads/${UPLOAD}`]: {},
    });
    const first = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: POST, ghImpl: gh.impl });
    const second = await closeOpenPrsAddingFile({ repo: "o/r", base: "main", filePath: IMAGE, ghImpl: gh.impl });
    expect(first).toEqual({ closed: [], merged: [] });
    expect(second).toEqual({ closed: [5001], merged: [] });
    expect(writes(gh.calls)).toEqual(["PATCH /repos/o/r/pulls/5001", `DELETE /repos/o/r/git/refs/heads/${UPLOAD}`]);
  });
});

// Both tags specs read the canary's ref through readFileOnRef (the AST lint
// below locks that): only a 404 means absent. The old preview hook treated
// every error as "UI delete succeeded, no cleanup needed".
test.describe("readFileOnRef (#689)", () => {
  const KEY = "GET /repos/o/r/contents/_tags/a.md?ref=feature%2Fx";
  const read = (routes) =>
    readFileOnRef({ repo: "o/r", ref: "feature/x", filePath: "_tags/a.md", ghImpl: fakeGh(routes).impl });

  test("returns the file when present", async () => {
    expect(await read({ [KEY]: { sha: "abc" } })).toEqual({ sha: "abc" });
  });

  test("returns null on a 404", async () => {
    expect(await read({ [KEY]: () => Promise.reject(httpError(404)) })).toBeNull();
  });

  for (const status of [401, 403, 500]) {
    test(`throws on a ${status} instead of reading absent`, async () => {
      await expect(read({ [KEY]: () => Promise.reject(httpError(status)) })).rejects.toThrow(String(status));
    });
  }

  test("throws on a network error", async () => {
    await expect(read({ [KEY]: () => Promise.reject(new TypeError("fetch failed")) })).rejects.toThrow(
      "fetch failed",
    );
  });
});

// Every safety net that creates its entry through Decap must stop the
// in-flight PR BEFORE it reads the ref; the reverse order is the #689
// incident (absent on main, PR still open). Each spec lists the identifiers
// its closeOpenPrsAddingFile calls must pass as `filePath`: the media spec's
// create PR adds both the post and the upload.
test.describe("Decap-created fixtures close the in-flight PR before reading the ref (#689)", () => {
  for (const [spec, closedPaths] of [
    ["cms-tags-lifecycle.spec.js", ["TAG_FILE_PATH"]],
    ["cms-tags-lifecycle-preview.spec.js", ["TAG_FILE_PATH"]],
    ["cms-publish-loop-prod-mutate.spec.js", ["filePath"]],
    ["cms-delete-published.spec.js", ["filePath"]],
    ["cms-media-roundtrip.spec.js", ["filePath", "imagePath"]],
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
      const closes = [];
      let read = null;
      walk.simple(hooks[0], {
        CallExpression(n) {
          const name = calleeName(n.callee);
          if (name === "closeOpenPrsAddingFile") {
            const arg = n.arguments[0];
            const prop =
              arg && arg.type === "ObjectExpression"
                ? arg.properties.find((p) => p.key && p.key.name === "filePath")
                : null;
            const value = prop && prop.value.type === "Identifier" ? prop.value.name : null;
            closes.push({ start: n.start, value });
          }
          if (name === "readFileOnRef" && (read === null || n.start < read)) read = n.start;
        },
      });
      expect(
        closes.map((c) => c.value).sort(),
        "afterAll calls closeOpenPrsAddingFile once per run-unique path it creates",
      ).toEqual([...closedPaths].sort());
      expect(read, "afterAll reads the ref through readFileOnRef").not.toBeNull();
      for (const c of closes) expect(c.start, `close of ${c.value} precedes the read`).toBeLessThan(read);
    });
  }
});
