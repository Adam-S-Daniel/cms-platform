// @lane: local — pure logic with injected fakes, no network: the #689
// leftover-e2e-tag sweep (e2e/leftover-e2e-tags.js) and the Decap-created
// fixtures' in-flight create-PR close (cms-fixture-pr.js
// closeOpenPrsAddingFile), plus an AST lint over those spec sources
// (harness-internal, so this file is registered in PLATFORM_META_SPECS).
const fs = require("node:fs");
const path = require("node:path");
const walk = require("acorn-walk");
const { parse, calleeName, stringValue } = require("./spec-ast");
const { test, expect } = require("./base");
const { classifyE2eTags, sweepLeftoverE2eTags, STALE_AFTER_MS } = require("./leftover-e2e-tags");
const { closeOpenPrsAddingFile, fixtureBranchName, listAllPages, readFileOnRef } = require("./cms-fixture-pr");
const { buildMediaRoundtripPost, mediaUploadRemovalSlug } = require("./prod-mutate-fixture");

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
  const ROOT = "GET /repos/o/r/git/trees/main";
  const TAGS_TREE = "GET /repos/o/r/git/trees/tagsha";
  const PULLS = "GET /repos/o/r/pulls?state=open&base=main&per_page=100&page=1";
  // The two git-trees reads that list `_tags` on main; `file`/`dir`
  // entries become blob/tree entries.
  const listing = (entries) => ({
    [ROOT]: {
      tree: [
        { path: "_posts", type: "tree", sha: "postsha" },
        { path: "_tags", type: "tree", sha: "tagsha" },
      ],
    },
    [TAGS_TREE]: {
      truncated: false,
      tree: entries.map((e) => ({ path: e.name, type: e.type === "file" ? "blob" : "tree", sha: "x" })),
    },
  });

  test("a site with no _tags directory has nothing left over", async () => {
    const gh = fakeGh({ [ROOT]: { tree: [{ path: "_posts", type: "tree", sha: "postsha" }] } });
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
    const gh = fakeGh({ [ROOT]: () => Promise.reject(httpError(500)) });
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
      ...listing([
        file(`e2e-tags-canary-${OLD}.md`),
        file(`e2e-tags-canary-${YOUNG}.md`),
        file(`e2e-tags-canary-${FUTURE}.md`),
        file("e2e-hand-made.md"),
        file("ruby.md"),
      ]),
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
      ...listing([file(`e2e-tags-canary-${OLD}.md`)]),
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

  test("a ref with no tree (404) has nothing left over", async () => {
    const gh = fakeGh({ [ROOT]: () => Promise.reject(httpError(404)) });
    const res = await sweepLeftoverE2eTags({
      repo: "o/r",
      ghImpl: gh.impl,
      removeImpl: async () => {
        throw new Error("no removal expected");
      },
      nowMs: NOW,
      log: () => {},
    });
    expect(res.leftover).toBe(0);
  });

  test("sees a leftover past the Contents API's 1,000-entry directory cap", async () => {
    // 1,500 real tags sorted before the canary: a Contents API listing
    // stops at 1,000 entries and would read this site clean.
    const real = Array.from({ length: 1500 }, (_, i) => file(`a-tag-${String(i).padStart(4, "0")}.md`));
    const gh = fakeGh({
      ...listing([...real, file(`e2e-tags-canary-${OLD}.md`), file("e2e-hand-made.md")]),
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
    expect(gh.calls.some((c) => c.includes("/contents/"))).toBe(false);
    expect(removed.map((a) => a.filePath)).toEqual([`_tags/e2e-tags-canary-${OLD}.md`]);
    expect(res.other).toEqual(["_tags/e2e-hand-made.md"]);
    expect(res.leftover).toBe(2);
  });

  test("a truncated _tags tree throws instead of reading partial", async () => {
    const routes = listing([file(`e2e-tags-canary-${OLD}.md`)]);
    routes[TAGS_TREE] = { ...routes[TAGS_TREE], truncated: true };
    const gh = fakeGh(routes);
    await expect(
      sweepLeftoverE2eTags({
        repo: "o/r",
        ghImpl: gh.impl,
        removeImpl: async () => {},
        nowMs: NOW,
        log: () => {},
      }),
    ).rejects.toThrow("truncated");
  });

  test("a truncated root tree with no _tags entry throws instead of reading clean", async () => {
    // A truncated root listing may have cut `_tags` itself, so its absence
    // proves nothing: "no directory" (nothing left over) would be a false clean.
    const gh = fakeGh({ [ROOT]: { truncated: true, tree: [{ path: "_posts", type: "tree", sha: "postsha" }] } });
    await expect(
      sweepLeftoverE2eTags({
        repo: "o/r",
        ghImpl: gh.impl,
        removeImpl: async () => {},
        nowMs: NOW,
        log: () => {},
      }),
    ).rejects.toThrow("root tree listing is truncated");
  });

  test("a truncated root tree that still lists _tags is swept normally", async () => {
    // The `_tags` entry is present, so its own (non-truncated) tree is the
    // authority: the root's `truncated` flag alone must not fail the sweep.
    const routes = listing([file(`e2e-tags-canary-${OLD}.md`)]);
    routes[ROOT] = { ...routes[ROOT], truncated: true };
    routes[PULLS] = [];
    const gh = fakeGh(routes);
    const removed = [];
    const res = await sweepLeftoverE2eTags({
      repo: "o/r",
      ghImpl: gh.impl,
      removeImpl: async (a) => removed.push(a),
      nowMs: NOW,
      log: () => {},
    });
    expect(removed.map((a) => a.filePath)).toEqual([`_tags/e2e-tags-canary-${OLD}.md`]);
    expect(res.leftover).toBe(1);
  });

  test("a failed removal throws", async () => {
    const gh = fakeGh({ ...listing([file(`e2e-tags-canary-${OLD}.md`)]), [PULLS]: [] });
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

// #697 — shapes the order lint above cannot see. Each check walks the spec's
// whole AST, so a helper outside the afterAll (tryHardDelete) is covered too.
const SAFETY_NET_SPECS = [
  "cms-tags-lifecycle.spec.js",
  "cms-tags-lifecycle-preview.spec.js",
  "cms-publish-loop-prod-mutate.spec.js",
  "cms-delete-published.spec.js",
  "cms-media-roundtrip.spec.js",
];
// Calls whose failure must surface: a close, a strict read, or a removal.
const STRICT_CALLS = new Set([
  "closeOpenPrsAddingFile",
  "readFileOnRef",
  "removeFixtureViaPr",
  "tryHardDelete",
  "createBranchFromMain",
  "deleteFileOnBranch",
  "openPr",
  "addReadyLabel",
]);
const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

function subtreeIdentifiers(node) {
  const names = new Set();
  walk.full(node, (n) => {
    if (n.type === "Identifier") names.add(n.name);
  });
  return names;
}

// A catch handler is loud when it throws, or records the error into a binding
// (`failures.push(e)`, `err = e`) that its enclosing function throws later.
function handlerIsLoud(handler, enclosingFn) {
  let throws = false;
  const records = new Set();
  walk.full(handler.body, (n) => {
    if (n.type === "ThrowStatement") throws = true;
    if (
      n.type === "CallExpression" &&
      n.callee.type === "MemberExpression" &&
      n.callee.property.name === "push" &&
      n.callee.object.type === "Identifier"
    ) {
      records.add(n.callee.object.name);
    }
    if (n.type === "AssignmentExpression" && n.left.type === "Identifier") records.add(n.left.name);
  });
  if (throws) return true;
  if (records.size === 0 || !enclosingFn) return false;
  // The rethrow must fire for EVERY non-zero count: each `if` between the
  // function body and the throw must test `X.length > 0` (or `!== 0`,
  // `>= 1`, bare `X.length`) with the throw in its consequent. A throw that
  // fires only for one count (`if (X.length > 1)`) leaves the others silent.
  let rethrown = false;
  walk.ancestor(enclosingFn.body, {
    ThrowStatement(n, _state, ancestors) {
      if (n.start >= handler.start && n.end <= handler.end) return;
      const names = [...subtreeIdentifiers(n.argument)].filter((name) => records.has(name));
      if (names.length === 0) return;
      const ok = ancestors.every((a, i) => {
        if (a.type !== "IfStatement") return true;
        return isNonEmptyTest(a.test, names) && a.consequent === ancestors[i + 1];
      });
      if (ok) rethrown = true;
    },
  });
  return rethrown;
}

// `X.length`, `X.length > 0`, `X.length !== 0`, `X.length != 0`, `X.length >= 1`.
function isNonEmptyTest(test, names) {
  const isLength = (n) =>
    n &&
    n.type === "MemberExpression" &&
    !n.computed &&
    n.property.name === "length" &&
    n.object.type === "Identifier" &&
    names.includes(n.object.name);
  if (isLength(test)) return true;
  if (test.type !== "BinaryExpression" || !isLength(test.left) || test.right.type !== "Literal") return false;
  const v = test.right.value;
  return (
    ((test.operator === ">" || test.operator === "!==" || test.operator === "!=") && v === 0) ||
    (test.operator === ">=" && v === 1)
  );
}

function strictTryViolations(ast) {
  const out = [];
  walk.ancestor(ast, {
    TryStatement(n, _state, ancestors) {
      if (!n.handler) return;
      const strict = [];
      walk.simple(n.block, {
        CallExpression(c) {
          const name = calleeName(c.callee);
          if (STRICT_CALLS.has(name)) strict.push(name);
        },
      });
      if (strict.length === 0) return;
      const fn = [...ancestors].reverse().find((a) => a !== n && FUNCTION_TYPES.has(a.type));
      if (!handlerIsLoud(n.handler, fn)) out.push(`line ${n.loc.start.line}: catch around ${strict.join(", ")} swallows the error`);
    },
  });
  return out;
}

function readCatchViolations(ast) {
  const out = [];
  walk.ancestor(ast, {
    CallExpression(n, _state, ancestors) {
      if (calleeName(n.callee) !== "readFileOnRef") return;
      const parent = ancestors[ancestors.length - 2];
      if (
        parent &&
        parent.type === "MemberExpression" &&
        parent.object === n &&
        parent.property &&
        ["catch", "then", "finally"].includes(parent.property.name)
      ) {
        out.push(`line ${n.loc.start.line}: readFileOnRef(...).${parent.property.name}(...)`);
      }
    },
  });
  return out;
}

// A string with no interpolation: a string Literal or an expression-free
// template literal (`main`). null for anything else.
function staticString(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const propNamed = (obj, name) =>
  obj && obj.type === "ObjectExpression"
    ? obj.properties.find((p) => p.key && (p.key.name || p.key.value) === name)
    : undefined;

// A write to the default branch, which the pull_request rule refuses
// (docs/CI-INVARIANTS.md: no bypass actors): a `branch: "main"` key (string or
// plain template), or a Contents-API PUT/DELETE whose inline JSON body names
// no branch (GitHub then writes the default branch) or cannot be read.
function directMainWrites(ast) {
  const out = [];
  walk.simple(ast, {
    Property(n) {
      const key = n.key && (n.key.name || n.key.value);
      if (key === "branch" && staticString(n.value) === "main") {
        out.push(`line ${n.loc.start.line}: branch: "main"`);
      }
    },
    CallExpression(n) {
      const url = stringValue(n.arguments[0]);
      if (url == null || !url.includes("/contents/")) return;
      const method = propNamed(n.arguments[1], "method");
      const verb = method && staticString(method.value);
      if (verb !== "PUT" && verb !== "DELETE") return;
      const body = propNamed(n.arguments[1], "body");
      const payload =
        body &&
        body.value.type === "CallExpression" &&
        calleeName(body.value.callee) === "JSON.stringify" &&
        body.value.arguments[0];
      if (!payload || payload.type !== "ObjectExpression") {
        out.push(`line ${n.loc.start.line}: contents ${verb} with a body the lint cannot read`);
      } else if (!propNamed(payload, "branch")) {
        out.push(`line ${n.loc.start.line}: contents ${verb} with no branch writes the default branch`);
      }
    },
  });
  return out;
}

test.describe("Decap fixture safety nets fail loudly and remove through a PR (#697)", () => {
  for (const spec of SAFETY_NET_SPECS) {
    const ast = () => parse(fs.readFileSync(path.join(__dirname, spec), "utf8"));
    test(`${spec}: readFileOnRef is never chained with a catch`, () => {
      expect(readCatchViolations(ast()), "only a 404 means absent; a .catch reads every error as absent").toEqual([]);
    });
    test(`${spec}: no catch around a close, read or removal swallows the error`, () => {
      expect(strictTryViolations(ast())).toEqual([]);
    });
    test(`${spec}: no direct write to main`, () => {
      expect(directMainWrites(ast())).toEqual([]);
    });
  }

  test("cms-media-roundtrip.spec.js: the afterAll removes both the post and the upload via removeFixtureViaPr", () => {
    const ast = parse(fs.readFileSync(path.join(__dirname, "cms-media-roundtrip.spec.js"), "utf8"));
    let hook = null;
    walk.simple(ast, {
      CallExpression(n) {
        if (calleeName(n.callee) === "test.afterAll") hook = n.arguments[n.arguments.length - 1];
      },
    });
    const removed = [];
    walk.simple(hook, {
      CallExpression(n) {
        if (calleeName(n.callee) !== "removeFixtureViaPr") return;
        const arg = n.arguments[0];
        const prop = arg.properties.find((p) => p.key && p.key.name === "filePath");
        // shorthand `{ filePath }` and `filePath: imagePath` both resolve to the value's name
        removed.push(prop && prop.value.type === "Identifier" ? prop.value.name : null);
      },
    });
    expect(removed.sort()).toEqual(["filePath", "imagePath"]);
  });

  // #697 item 3: a failed post leg must not skip the upload leg, so every
  // close, read and removal in the media hook sits in its own try (whose
  // catch the rule above requires to record and rethrow).
  test("cms-media-roundtrip.spec.js: every close, read and removal in the afterAll is inside a try", () => {
    const ast = parse(fs.readFileSync(path.join(__dirname, "cms-media-roundtrip.spec.js"), "utf8"));
    let hook = null;
    walk.simple(ast, {
      CallExpression(n) {
        if (calleeName(n.callee) === "test.afterAll") hook = n.arguments[n.arguments.length - 1];
      },
    });
    const bare = [];
    walk.ancestor(hook, {
      CallExpression(n, _state, ancestors) {
        const name = calleeName(n.callee);
        if (!STRICT_CALLS.has(name)) return;
        const guarded = ancestors.some((a, i) => a.type === "TryStatement" && ancestors[i + 1] === a.block);
        if (!guarded) bare.push(`line ${n.loc.start.line}: ${name}`);
      },
    });
    expect(bare).toEqual([]);
  });

  // #697: the post's slug equals the upload's basename, and removeFixtureViaPr
  // names its branch from slug + runId, so the upload leg needs its own slug or
  // its createBranchFromMain recreates the branch under the post's removal PR.
  test("cms-media-roundtrip: the post and upload removal PRs get different branches", () => {
    const runId = 1790000000000;
    const { slug } = buildMediaRoundtripPost({ runId });
    expect(slug, "the collision this guards against").toBe(`e2e-media-roundtrip-${runId}`);
    const post = fixtureBranchName({ slug, runId, action: "remove" });
    const upload = fixtureBranchName({ slug: mediaUploadRemovalSlug(slug), runId, action: "remove" });
    expect(upload).not.toBe(post);
  });

  test("cms-media-roundtrip.spec.js: the upload removal uses mediaUploadRemovalSlug, the post its own slug", () => {
    const ast = parse(fs.readFileSync(path.join(__dirname, "cms-media-roundtrip.spec.js"), "utf8"));
    let hook = null;
    walk.simple(ast, {
      CallExpression(n) {
        if (calleeName(n.callee) === "test.afterAll") hook = n.arguments[n.arguments.length - 1];
      },
    });
    const slugs = {};
    walk.simple(hook, {
      CallExpression(n) {
        if (calleeName(n.callee) !== "removeFixtureViaPr") return;
        const file = propNamed(n.arguments[0], "filePath");
        const slug = propNamed(n.arguments[0], "slug");
        const v = slug && slug.value;
        slugs[file.value.name] =
          v.type === "Identifier"
            ? v.name
            : v.type === "CallExpression" && v.arguments[0] && v.arguments[0].type === "Identifier"
              ? `${calleeName(v.callee)}(${v.arguments[0].name})`
              : null;
      },
    });
    expect(slugs).toEqual({ filePath: "slug", imagePath: "mediaUploadRemovalSlug(slug)" });
  });

  // The detectors themselves, on the mutations the #694 review found surviving.
  test("the detectors flag the surviving mutations", () => {
    const src = (body) => parse(body);
    // The review's mutant is `.catch(() => null)`; any handler reads an error
    // as a value, and the repo's silent-catch lint forbids that literal here.
    expect(readCatchViolations(src("async function f(){ await readFileOnRef({}).catch(() => false); }"))).toHaveLength(1);
    expect(readCatchViolations(src("async function f(){ await readFileOnRef({}); }"))).toEqual([]);
    const warnOnly =
      "async function tryHardDelete(){ try { await removeFixtureViaPr({}); } catch (e) { console.warn(e); } }";
    expect(strictTryViolations(src(warnOnly))).toHaveLength(1);
    const rethrow =
      "async function tryHardDelete(){ try { await removeFixtureViaPr({}); } catch (e) { throw new Error(String(e)); } }";
    expect(strictTryViolations(src(rethrow))).toEqual([]);
    const recorded =
      "async function h(){ const f = []; try { await readFileOnRef({}); } catch (e) { f.push(e); } if (f.length) throw f[0]; }";
    expect(strictTryViolations(src(recorded))).toEqual([]);
    const recordedNeverThrown =
      "async function h(){ const f = []; try { await readFileOnRef({}); } catch (e) { f.push(e); } }";
    expect(strictTryViolations(src(recordedNeverThrown))).toHaveLength(1);
    expect(
      directMainWrites(src("gh('/x', { body: JSON.stringify({ sha: 's', branch: \"main\" }) })")),
    ).toHaveLength(1);
    expect(directMainWrites(src("gh('/x', { body: JSON.stringify({ branch: `main` }) })"))).toHaveLength(1);
    const del = (body) => `gh(\`/repos/\${R}/contents/\${P}\`, { method: "DELETE", body: ${body} })`;
    expect(directMainWrites(src(del("JSON.stringify({ sha: s })")))).toHaveLength(1);
    expect(directMainWrites(src(del("payload")))).toHaveLength(1);
    expect(directMainWrites(src(del("JSON.stringify({ sha: s, branch: HEAD_REF })")))).toEqual([]);
    const countOnly =
      "async function h(){ const f = []; try { await readFileOnRef({}); } catch (e) { f.push(e); } " +
      "if (f.length > 1) throw new AggregateError(f); }";
    expect(strictTryViolations(src(countOnly))).toHaveLength(1);
    const elseOnly =
      "async function h(){ const f = []; try { await readFileOnRef({}); } catch (e) { f.push(e); } " +
      "if (f.length === 1) console.warn(f[0]); else if (f.length > 0) throw f[0]; }";
    expect(strictTryViolations(src(elseOnly))).toHaveLength(1);
  });
});
