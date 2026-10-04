// @lane: local — pure-fs AST lint + vm unit test for the disposable-test-post markers (#531)
//
// A real-lane spec that creates a post through Decap's "+ New Post" form
// publishes it on a live site (production, or a PR preview). The `posts`
// collection has no `robots`/`sitemap` widget and its `test_fixture` is a
// hidden `false`, so the form alone lands a born-published post with no
// robots noindex tag — the cms-media-roundtrip.spec.js and
// cms-publish-loop-prod-mutate.spec.js gap. Both now call
// `markEphemeralTestPost` (e2e/cms-editor-ui.js) before their first Save,
// which stamps TEST_POST_MARKERS (e2e/prod-mutate-fixture.js) through a Decap
// `preSave` listener.
//
// This file locks that, by AST (acorn), never regex: the admin URL is a
// VARIABLE inside a template literal (`${PROD_ADMIN}#/collections/posts/new`),
// and a regex scan would also match the same text in a comment. The analysis
// lives in e2e/prod-test-post-markers-lint.js and FAILS CLOSED — see its
// header. Each evasion it closes has its own test below, and a lint that cannot
// prove a post is marked is not a pass.
//
// Two more locks: both production UI specs fetch the created file from the
// create PR's head and assert all three keys (the listener silently no-ops when
// the collection or title does not match), and the listener installed by the
// REAL markEphemeralTestPost stamps exactly TEST_POST_MARKERS (a helper that
// passed `markers: {}` would satisfy every other pure-fs check).
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");
const { parseLaneDirective } = require("./select-specs");
const { installTestPostMarkers, markEphemeralTestPost } = require("./cms-editor-ui");
const {
  TEST_POST_MARKERS,
  buildMediaRoundtripPost,
  missingTestPostMarkers,
} = require("./prod-mutate-fixture");
const lint = require("./prod-test-post-markers-lint");

const E2E_DIR = __dirname;
const { MARK, analyze, helperCreators, requiredModuleSources } = lint;

// `goto()` targets in a real-lane spec that are not a static route, allowed
// because they load an admin shell or a public page and name no collection
// route (so they cannot open a new-entry form). Keyed by spec, then by the
// argument's source text. An entry nothing uses fails the test below, so the
// list cannot rot.
const ADMIN_ROOT = "loads the admin shell (a base URL), not a collection route";
const GOTO_ALLOW = {
  "cms-delete-published.spec.js": { PROD_ADMIN: ADMIN_ROOT },
  "cms-media-roundtrip.spec.js": { PROD_ADMIN: ADMIN_ROOT },
  "cms-publish-loop-preview.spec.js": { PREVIEW_ADMIN: ADMIN_ROOT },
  "cms-publish-loop-prod-mutate-preview.spec.js": { PREVIEW_ADMIN: ADMIN_ROOT },
  "cms-publish-loop-prod-mutate.spec.js": { PROD_ADMIN: ADMIN_ROOT },
  "cms-publish-loop.spec.js": {
    PROD_ADMIN: ADMIN_ROOT,
    PUBLIC_URL: "loads the public page of the persistent canary post",
  },
  "cms-tags-lifecycle-preview.spec.js": { PREVIEW_ADMIN: ADMIN_ROOT },
  "cms-tags-lifecycle.spec.js": { PROD_ADMIN: ADMIN_ROOT },
  "cms-unpublish-republish-preview.spec.js": { PREVIEW_ADMIN: ADMIN_ROOT },
  "cms-unpublish-republish.spec.js": { PROD_ADMIN: ADMIN_ROOT },
};

function realLaneSpecs() {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.js"))
    .filter((f) => parseLaneDirective(path.join(E2E_DIR, f)) === "real");
}

function analyzeSpecFile(f) {
  const file = path.join(E2E_DIR, f);
  const externalCreators = helperCreators(requiredModuleSources(file));
  return analyze(fs.readFileSync(file, "utf8"), { externalCreators });
}

// A minimal stand-in for the Immutable.Map entries Decap hands a preSave
// handler: `get`, and a `set` that returns a NEW map.
class FakeMap {
  constructor(obj) {
    this.obj = { ...obj };
  }
  get(key) {
    return this.obj[key];
  }
  set(key, value) {
    return new FakeMap({ ...this.obj, [key]: value });
  }
}

// Run installTestPostMarkers exactly as Playwright does — from its source text,
// in a fresh context that has only `window` — and return the handlers it
// registered.
function installInSandbox(arg, { withCms = true } = {}) {
  const registered = [];
  const window = withCms
    ? { CMS: { registerEventListener: (listener) => registered.push(listener) } }
    : {};
  const result = vm.runInNewContext(`(${installTestPostMarkers.toString()})(arg)`, { window, arg });
  return { result, registered };
}

test.describe("disposable test posts carry noindex, sitemap:false, test_fixture (#531)", () => {
  test("every real-lane spec that opens a posts new-entry form marks the post before Save", () => {
    const creators = [];
    const usedAllow = new Set();
    for (const f of realLaneSpecs()) {
      const { sites, gotos } = analyzeSpecFile(f);
      if (sites.length) creators.push(f);
      for (const site of sites) {
        expect(
          site.marked,
          `${f}:${site.line} opens a posts new-entry form on a live site but does not call ` +
            `${MARK}(page, { title }) before its next Save` +
            (site.saveLine ? ` (line ${site.saveLine})` : "") +
            (site.note ? ` — ${site.note}` : "") +
            ` — the post would publish with no robots noindex tag, no sitemap:false and ` +
            `test_fixture:false (#531).`,
        ).toBe(true);
      }
      // Fail closed: a goto() the lint cannot resolve to a static route might
      // open the form, so it needs an explicit reason on GOTO_ALLOW.
      for (const g of gotos) {
        const reason = (GOTO_ALLOW[f] || {})[g.arg];
        expect(
          reason,
          `${f}:${g.line} goto(${g.arg}) cannot be resolved to a static route, so this lint cannot tell ` +
            `whether it opens a posts new-entry form. Write the route inline or as a const, or add ` +
            `it to GOTO_ALLOW with the reason it cannot create a post.`,
        ).toBeTruthy();
        usedAllow.add(`${f}\n${g.arg}`);
      }
    }
    for (const [f, entries] of Object.entries(GOTO_ALLOW)) {
      for (const arg of Object.keys(entries)) {
        expect(usedAllow.has(`${f}\n${arg}`), `GOTO_ALLOW entry ${f} goto(${arg}) matches nothing — delete it`).toBe(true);
      }
    }
    // Detector-blindness guard: the two known production post creators must be
    // SEEN, so a parser or matcher regression cannot turn this lint vacuous.
    expect(creators).toEqual(
      expect.arrayContaining(["cms-media-roundtrip.spec.js", "cms-publish-loop-prod-mutate.spec.js"]),
    );
  });

  // ── one test per evasion the first version of this lint was blind to ────
  const HEAD = 'const A = "https://example.com/admin/";\n';
  const markedFlags = (src, opts) => analyze(HEAD + src, opts).sites.map((s) => s.marked);
  const NEW_POST = "`${A}#/collections/posts/new`";
  const MARK_CALL = `await ${MARK}(page, { title: "T" })`;
  const MARKED = `${MARK_CALL};`;

  test("control: an inline goto is flagged unmarked, late-marked and marked correctly", () => {
    const unmarked = analyze(`${HEAD}async function t(page){ await page.goto(${NEW_POST}); await saveEntry(page); }`);
    expect(unmarked.sites).toEqual([{ line: 2, saveLine: 2, marked: false, note: "" }]);
    expect(markedFlags(`async function t(page){ await page.goto(${NEW_POST}); await saveEntry(page); ${MARKED} }`)).toEqual([false]);
    expect(markedFlags(`async function t(page){ await page.goto(${NEW_POST}); ${MARKED} await saveEntry(page); }`)).toEqual([true]);
    expect(markedFlags(`async function t(page){ await page.goto(${NEW_POST}); ${MARKED} await publishViaUi(page); }`)).toEqual([true]);
  });

  test("control: another collection, a constant collection and a comment are not creation sites", () => {
    const tags = "async function t(page){ await page.goto(`${A}#/collections/tags/new`); await saveEntry(page); }";
    const constCol = 'const col = "tags";\nasync function t(page){ await page.goto(`${A}#/collections/${col}/new`); await saveEntry(page); }';
    const comment = "// await page.goto(`${A}#/collections/posts/new`)\nasync function t(page){ await saveEntry(page); }";
    expect(analyze(HEAD + tags).sites).toEqual([]);
    expect(analyze(HEAD + constCol).sites).toEqual([]);
    expect(analyze(HEAD + comment).sites).toEqual([]);
  });

  test("a dynamic collection and collectionNewLink are creation sites", () => {
    expect(markedFlags("async function t(page, col){ await page.goto(`${A}#/collections/${col}/new`); await publishViaUi(page); }")).toEqual([false]);
    expect(markedFlags('async function t(page){ await collectionNewLink(page, "Post").click(); await saveEntry(page); }')).toEqual([false]);
    expect(markedFlags('async function t(page){ await collectionNewLink(page, "Tag").click(); await saveEntry(page); }')).toEqual([]);
  });

  test("evasion: a template assigned to a variable, then goto(variable)", () => {
    const src = `async function t(page){ const u = ${NEW_POST}; await page.goto(u); await saveEntry(page); }`;
    expect(markedFlags(src)).toEqual([false]);
    expect(markedFlags(src.replace("await saveEntry", `${MARKED} await saveEntry`))).toEqual([true]);
  });

  test("evasion: a module-level const passed to goto, and one site per use", () => {
    const decl = `const NEW = ${NEW_POST};\n`;
    const body = (m) => `async function t(page){ await page.goto(NEW); ${m} await saveEntry(page); }`;
    expect(markedFlags(decl + body(""))).toEqual([false]);
    expect(markedFlags(decl + body(MARKED))).toEqual([true]);
    // The second test's use is its own site, so one marker cannot cover both.
    const two = `${decl}${body(MARKED)}\n${body("")}`;
    expect(markedFlags(two)).toEqual([true, false]);
  });

  test("evasion: goto(urls.newPost) on an object of routes", () => {
    const src = `const urls = { newPost: ${NEW_POST} };\nasync function t(page){ await page.goto(urls.newPost); await saveEntry(page); }`;
    expect(markedFlags(src)).toEqual([false]);
  });

  test("evasion: a route built by concatenation or join", () => {
    expect(markedFlags('async function t(page){ await page.goto(A + "#/collections/" + "posts" + "/new"); await saveEntry(page); }')).toEqual([false]);
    expect(markedFlags('async function t(page){ await page.goto(["#", "collections", "posts", "new"].join("/")); await saveEntry(page); }')).toEqual([false]);
  });

  test("evasion: page[\"goto\"](...) and goto.call(...)", () => {
    expect(markedFlags(`async function t(page){ await page["goto"](${NEW_POST}); await saveEntry(page); }`)).toEqual([false]);
    expect(markedFlags(`async function t(page){ await page.goto.call(page, ${NEW_POST}); await saveEntry(page); }`)).toEqual([false]);
    // Computed or called-by-reference gotos with an argument we cannot resolve fail closed.
    expect(analyze(HEAD + 'async function t(page, u){ await page["goto"](u); }').gotos).toEqual([{ line: 2, arg: "u" }]);
    expect(analyze(HEAD + "async function t(page, u){ await page.goto.call(page, u); }").gotos).toEqual([{ line: 2, arg: "u" }]);
  });

  test("evasion: a goto whose target is not a static route is reported", () => {
    const gotos = (src) => analyze(HEAD + src).gotos.map((g) => g.arg);
    expect(gotos("async function t(page, url){ await page.goto(url); }")).toEqual(["url"]);
    expect(gotos("async function t(page, base){ await page.goto(`${base}`); }")).toEqual(["`${base}`"]);
    expect(gotos("async function t(page, args){ await page.goto(...args); }")).toEqual(["...args"]);
    expect(gotos("async function t(page){ await page.goto(); }")).toEqual(["<none>"]);
    expect(gotos("async function t(page){ const g = page.goto.bind(page); }")).toEqual(["<goto reference>"]);
    expect(gotos("async function t(page){ const { goto } = page; }")).toEqual(["<goto reference>"]);
    // A static route behind an interpolated base, a constant, and a literal are fine.
    expect(gotos("async function t(page, base){ await page.goto(`${base}#/collections/tags/entries/x`); }")).toEqual([]);
    expect(gotos("async function t(page){ await page.goto(A); await page.goto('https://example.com/'); }")).toEqual([]);
  });

  test("evasion: a click on the new-post link, and a location.hash assignment", () => {
    const click = 'async function t(page){ await page.locator(\'a[href="#/collections/posts/new"]\').click(); await saveEntry(page); }';
    const hash = 'async function t(page){ await page.evaluate(() => { location.hash = "#/collections/posts/new"; }); await saveEntry(page); }';
    expect(markedFlags(click)).toEqual([false]);
    expect(markedFlags(hash)).toEqual([false]);
    expect(markedFlags(click.replace("await saveEntry", `${MARKED} await saveEntry`))).toEqual([true]);
  });

  test("evasion: a helper in another module opens the form", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "post-markers-"));
    try {
      fs.writeFileSync(
        path.join(dir, "post-helper.js"),
        'async function openNewPost(page) { await page.goto("https://example.com/admin/#/collections/posts/new"); }\nmodule.exports = { openNewPost };\n',
      );
      fs.writeFileSync(
        path.join(dir, "wraps.js"),
        'const { openNewPost } = require("./post-helper");\nasync function startPost(page) { await openNewPost(page); }\nmodule.exports = { startPost };\n',
      );
      const spec = (m) =>
        `const { startPost } = require("./wraps");\ntest("x", async ({ page }) => { await startPost(page); ${m} await saveEntry(page); });\n`;
      fs.writeFileSync(path.join(dir, "x.spec.js"), spec(""));
      const external = helperCreators(requiredModuleSources(path.join(dir, "x.spec.js")));
      // The wrapper is a creator too: the fixed point sees through a second hop.
      expect([...external].sort()).toEqual(["openNewPost", "startPost"]);
      expect(analyze(spec(""), { externalCreators: external }).sites.map((s) => s.marked)).toEqual([false]);
      expect(analyze(spec(MARKED), { externalCreators: external }).sites.map((s) => s.marked)).toEqual([true]);
      // Without module scanning the same spec reads as "no creation site" — the old blind spot.
      expect(analyze(spec("")).sites).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a helper function in the spec itself: its call sites, not its body, are the creation sites", () => {
    const fn = `async function openNew(page){ await page.goto(${NEW_POST}); }\n`;
    expect(markedFlags(`${fn}async function t(page){ await openNew(page); ${MARKED} await saveEntry(page); }`)).toEqual([true]);
    expect(markedFlags(`${fn}async function t(page){ await openNew(page); await saveEntry(page); }`)).toEqual([false]);
    // Never called: the route itself is the site (fail closed).
    expect(markedFlags(fn)).toEqual([false]);
  });

  test("a marker call must carry a title", () => {
    const flags = (call) =>
      markedFlags(`async function t(page){ await page.goto(${NEW_POST}); await ${call}; await saveEntry(page); }`);
    expect(flags(`${MARK}(page)`)).toEqual([false]);
    expect(flags(`${MARK}(page, {})`)).toEqual([false]);
    expect(flags(`${MARK}(page, opts)`)).toEqual([false]);
    expect(flags(`${MARK}(page, { title: undefined })`)).toEqual([false]);
    expect(flags(`${MARK}(page, { title: "" })`)).toEqual([false]);
    expect(flags(`${MARK}(page, { ...opts })`)).toEqual([false]);
    expect(flags(`${MARK}(page, { title })`)).toEqual([true]);
    expect(flags(`${MARK}(page, { title: "T" })`)).toEqual([true]);
    expect(analyze(`${HEAD}async function t(page){ await page.goto(${NEW_POST}); await ${MARK}(page); await saveEntry(page); }`).sites[0].note).toMatch(/no title/);
  });

  test("a marker call inside a constant-false branch does not count", () => {
    const wrap = (pre, post = "") =>
      `${HEAD}const OFF = false;\nasync function t(page){ await page.goto(${NEW_POST}); ${pre}${MARK_CALL}${post}; await saveEntry(page); }`;
    const flags = (src) => analyze(src).sites.map((s) => s.marked);
    expect(flags(wrap("if (false) { ", " }"))).toEqual([false]);
    expect(flags(wrap("if (0) { ", " }"))).toEqual([false]);
    expect(flags(wrap("if (!true) { ", " }"))).toEqual([false]);
    expect(flags(wrap("if (OFF) { ", " }"))).toEqual([false]);
    expect(flags(wrap("if (true) {} else { ", " }"))).toEqual([false]);
    expect(flags(wrap("false && ", ""))).toEqual([false]);
    expect(flags(wrap("OFF ? 0 : ", ""))).toEqual([true]); // the else arm runs
    expect(flags(wrap("OFF ? ", " : 0"))).toEqual([false]);
    expect(flags(wrap("while (false) { ", " }"))).toEqual([false]);
    expect(analyze(wrap("if (false) { ", " }")).sites[0].note).toMatch(/can never run/);
    // Controls: a live branch and an unknown condition count.
    expect(flags(wrap("if (true) { ", " }"))).toEqual([true]);
    expect(flags(wrap("if (process.env.X) { ", " }"))).toEqual([true]);
    expect(flags(wrap("true && ", ""))).toEqual([true]);
  });

  test("a raw getByRole('button', { name: /save/ }).click() is a Save", () => {
    const raw = 'await page.getByRole("button", { name: /save/i }).click();';
    const flags = (body) => markedFlags(`async function t(page){ await page.goto(${NEW_POST}); ${body} }`);
    expect(flags(`${raw} ${MARKED}`)).toEqual([false]);
    expect(flags(`${MARKED} ${raw}`)).toEqual([true]);
    expect(flags('await page.getByRole("button", { name: "Save" }).first().click(); ' + MARKED)).toEqual([false]);
    expect(flags('await page.getByRole("button", { name: nameOf(x) }).click(); ' + MARKED)).toEqual([false]);
    // Controls: other buttons, and other roles, are not a Save.
    expect(flags('await page.getByRole("button", { name: /close/i }).click(); ' + MARKED)).toEqual([true]);
    expect(flags('await page.getByRole("link", { name: /save/i }).click(); ' + MARKED)).toEqual([true]);
    expect(analyze(`${HEAD}async function t(page){ await page.goto(${NEW_POST}); ${raw} }`).sites[0].saveLine).toBe(2);
  });

  test("a spec that does not parse fails the lint instead of reading as 'no creation site'", () => {
    expect(() => analyze("const = ;")).toThrow();
  });

  test("the in-page preSave listener stamps exactly TEST_POST_MARKERS onto the run's own post", async () => {
    const { result, registered } = installInSandbox({ title: "E2E Run 7", markers: { ...TEST_POST_MARKERS } });
    expect(result).toBe(true);
    expect(registered.map((l) => l.name)).toEqual(["preSave"]);
    const { handler } = registered[0];

    const post = (title) =>
      new FakeMap({ collection: "posts", data: new FakeMap({ title, published: true, test_fixture: false }) });
    const stamped = await handler({ entry: post("E2E Run 7") });
    expect(stamped.obj).toEqual({ title: "E2E Run 7", published: true, ...TEST_POST_MARKERS });

    // Another post, or another collection with the same title, is untouched:
    // `undefined` is Decap's "no change".
    expect(await handler({ entry: post("A real post") })).toBeUndefined();
    const tag = new FakeMap({ collection: "tags", data: new FakeMap({ title: "E2E Run 7" }) });
    expect(await handler({ entry: tag })).toBeUndefined();
  });

  test("the listener installed by the REAL markEphemeralTestPost stamps exactly TEST_POST_MARKERS", async () => {
    const registered = [];
    const window = { CMS: { registerEventListener: (listener) => registered.push(listener) } };
    // The fake page runs the helper's in-page function the way Playwright does:
    // from its source text, in a fresh context, with the helper's own argument.
    const page = {
      evaluate: async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(arg)`, { window, arg }),
    };
    await markEphemeralTestPost(page, { title: "E2E Run 9" });
    expect(registered.map((l) => l.name)).toEqual(["preSave"]);
    const post = new FakeMap({
      collection: "posts",
      data: new FakeMap({ title: "E2E Run 9", published: true, test_fixture: false }),
    });
    const stamped = await registered[0].handler({ entry: post });
    // A helper that passed `markers: {}` (or any subset) fails this.
    expect(stamped.obj).toEqual({ title: "E2E Run 9", published: true, ...TEST_POST_MARKERS });
    await expect(markEphemeralTestPost(page, {})).rejects.toThrow(/requires the post's unique title/);
  });

  test("missingTestPostMarkers names every marker the front matter lacks", () => {
    const post = (extra) => `---\ntitle: T\n${extra}---\n\nBody\n`;
    const all = "robots: noindex,nofollow\nsitemap: false\ntest_fixture: true\n";
    expect(missingTestPostMarkers(post(all))).toEqual([]);
    expect(missingTestPostMarkers(buildMediaRoundtripPost({ runId: 7 }).fileText)).toEqual([]);
    expect(missingTestPostMarkers(post(""))).toEqual(["robots", "sitemap", "test_fixture"]);
    expect(missingTestPostMarkers(post("robots: noindex,nofollow\nsitemap: false\ntest_fixture: false\n"))).toEqual(["test_fixture"]);
    expect(missingTestPostMarkers(post("robots: index\nsitemap: 'false'\ntest_fixture: true\n"))).toEqual(["robots", "sitemap"]);
    expect(missingTestPostMarkers("no front matter")).toEqual(["robots", "sitemap", "test_fixture"]);
    expect(missingTestPostMarkers("---\n: : [\n---\n")).toEqual(["robots", "sitemap", "test_fixture"]);
  });

  // ── both production UI specs prove the markers on the committed file ──
  // The listener returns `undefined` (no change) on a collection/title
  // mismatch and Decap then saves WITHOUT markers, silently. So after the wait
  // for the CMS pull request and before the spec waits for the post to serve,
  // the spec must fetch the created file from that PR's head and
  // `expect(missingTestPostMarkers(file)).toEqual([])`.
  const UI_SPECS = ["cms-media-roundtrip.spec.js", "cms-publish-loop-prod-mutate.spec.js"];

  // Does `src` assert the markers on the PR-head file, in the right window?
  function provesMarkersOnPrHead(src) {
    const ix = lint.index(src);
    const calls = [];
    for (const { node, ancestors } of ix.nodes) {
      if (node.type !== "CallExpression") continue;
      const info = lint.calleeInfo(ix, node);
      calls.push({ node, ancestors, ...info, start: node.start });
    }
    const wait = calls.find((c) => c.tail === "waitForCmsPullRequest");
    if (!wait) return "no waitForCmsPullRequest call";
    const serve = calls.find((c) => c.tail === "waitForChangeReflected" && c.start > wait.start);
    const end = serve ? serve.start : Infinity;
    const inWindow = (c) => c.start > wait.start && c.start < end;
    for (const check of calls.filter((c) => c.tail === "missingTestPostMarkers" && inWindow(c))) {
      // expect(missingTestPostMarkers(<file>)).toEqual([])
      const expectCall = check.ancestors[check.ancestors.length - 1];
      if (!expectCall || expectCall.type !== "CallExpression" || expectCall.callee.name !== "expect") continue;
      const matcher = check.ancestors[check.ancestors.length - 2];
      const matcherCall = check.ancestors[check.ancestors.length - 3];
      if (!matcher || matcher.type !== "MemberExpression" || matcher.property.name !== "toEqual") continue;
      const empty = matcherCall && matcherCall.arguments[0];
      if (!empty || empty.type !== "ArrayExpression" || empty.elements.length !== 0) continue;
      if (lint.isDead(ix, check.node, check.ancestors)) continue;
      // The file must come from getFileTextAtRef at the PR head.
      const fileArg = check.node.arguments[0];
      const init = fileArg && fileArg.type === "Identifier" ? (ix.consts.get(fileArg.name) || [])[0] : null;
      const fetched = init && init.type === "AwaitExpression" ? init.argument : null;
      if (!fetched || fetched.type !== "CallExpression" || fetched.callee.name !== "getFileTextAtRef") continue;
      if (!fetched.arguments[0] || !/head\.sha/.test(ix.src.slice(fetched.arguments[0].start, fetched.arguments[0].end))) continue;
      return null;
    }
    return "no expect(missingTestPostMarkers(await getFileTextAtRef({ …, ref: pr.head.sha }))).toEqual([]) between the PR wait and the serve wait";
  }

  test("both production UI specs assert the markers on the created file after the PR wait", () => {
    for (const f of UI_SPECS) {
      expect(provesMarkersOnPrHead(fs.readFileSync(path.join(E2E_DIR, f), "utf8")), f).toBeNull();
    }
  });

  test("the PR-head assertion check fails on each way the assertion can go missing", () => {
    const good = [
      "async function t() {",
      "  const pr = await waitForCmsPullRequest({});",
      "  const created = await getFileTextAtRef({ filePath, ref: pr.head.sha });",
      "  expect(missingTestPostMarkers(created)).toEqual([]);",
      "  await waitForChangeReflected({});",
      "}",
    ].join("\n");
    expect(provesMarkersOnPrHead(good)).toBeNull();
    const without = (needle, repl = "") => good.replace(needle, repl);
    expect(provesMarkersOnPrHead(without("  expect(missingTestPostMarkers(created)).toEqual([]);\n"))).toMatch(/no expect/);
    // Moved after the serve wait.
    const late = good
      .replace("  expect(missingTestPostMarkers(created)).toEqual([]);\n", "")
      .replace("  await waitForChangeReflected({});\n", "  await waitForChangeReflected({});\n  expect(missingTestPostMarkers(created)).toEqual([]);\n");
    expect(late).not.toBe(good);
    expect(provesMarkersOnPrHead(late)).toMatch(/no expect/);
    // Weakened: not an empty-list match, wrong source, wrong ref, dead branch, no PR wait.
    expect(provesMarkersOnPrHead(without("toEqual([])", 'toEqual(["robots"])'))).toMatch(/no expect/);
    expect(provesMarkersOnPrHead(without("toEqual([])", "toBeDefined()"))).toMatch(/no expect/);
    expect(provesMarkersOnPrHead(without("await getFileTextAtRef({ filePath, ref: pr.head.sha })", "fixtureText"))).toMatch(/no expect/);
    expect(provesMarkersOnPrHead(without("ref: pr.head.sha", 'ref: "main"'))).toMatch(/no expect/);
    expect(provesMarkersOnPrHead(without("  expect(missingTestPostMarkers(created)).toEqual([]);", "  if (false) { expect(missingTestPostMarkers(created)).toEqual([]); }"))).toMatch(/no expect/);
    expect(provesMarkersOnPrHead(without("waitForCmsPullRequest", "somethingElse"))).toMatch(/no waitForCmsPullRequest/);
  });

  test("the installer fails loudly when Decap's CMS API is not loaded", () => {
    expect(() => installInSandbox({ title: "T", markers: {} }, { withCms: false })).toThrow(
      /registerEventListener is unavailable/,
    );
  });

  test("TEST_POST_MARKERS is the documented trio, and the fixture builder writes the same values", () => {
    expect(TEST_POST_MARKERS).toEqual({ robots: "noindex,nofollow", sitemap: false, test_fixture: true });
    const { fileText } = buildMediaRoundtripPost({ runId: 7 });
    const frontMatter = YAML.parse(fileText.split(/^---$/m)[1]);
    for (const [key, value] of Object.entries(TEST_POST_MARKERS)) {
      expect(frontMatter[key], `composePost front matter ${key}`).toBe(value);
    }
  });
});
