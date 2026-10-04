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
// This file locks that, by AST (acorn, via spec-ast.js), never regex: the
// admin URL is a VARIABLE inside a template literal
// (`${PROD_ADMIN}#/collections/posts/new`), and a regex scan would also match
// the same text in a comment. A creation site is a `*.goto(url)` whose
// reconstructed URL opens a posts new-entry form — or a new-entry form for a
// collection named by an interpolation, which may be posts — or a
// `collectionNewLink(page, <posts-ish or dynamic label>)`. Each must be
// followed by a `markEphemeralTestPost(...)` call before the next
// `saveEntry(...)`/`publishViaUi(...)`.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const YAML = require("yaml");
const { test, expect } = require("./base");
const walk = require("acorn-walk");
const { parse, calleeName, calleeTail, stringValue } = require("./spec-ast");
const { parseLaneDirective } = require("./select-specs");
const { installTestPostMarkers } = require("./cms-editor-ui");
const { TEST_POST_MARKERS, buildMediaRoundtripPost } = require("./prod-mutate-fixture");

const E2E_DIR = __dirname;
const MARK = "markEphemeralTestPost";
const SAVES = new Set(["saveEntry", "publishViaUi"]);

// These matchers run on the URL/label string the AST reconstructed from a
// Literal or TemplateLiteral (interpolations become "${…}"), not on source.
const POSTS_NEW_URL = /collections\/(?:posts|\$\{…\})\/new\b/;
const POSTS_NEW_LABEL = /post|\$\{…\}/i;

function isCreationSite(call) {
  if (call.tail === "goto") {
    const url = stringValue(call.args[0]);
    return url != null && POSTS_NEW_URL.test(url);
  }
  if (call.tail === "collectionNewLink") {
    const label = stringValue(call.args[1]);
    return label == null || POSTS_NEW_LABEL.test(label);
  }
  return false;
}

// Every posts-creation site in `src` and whether it is marked before its Save.
function postCreationSites(src) {
  const calls = [];
  walk.full(parse(src), (node) => {
    if (node.type !== "CallExpression") return;
    const name = calleeName(node.callee);
    calls.push({ tail: calleeTail(name), args: node.arguments, start: node.start, line: node.loc.start.line });
  });
  calls.sort((a, b) => a.start - b.start);
  return calls.filter(isCreationSite).map((site) => {
    const save = calls.find((c) => c.start > site.start && SAVES.has(c.tail));
    const end = save ? save.start : Infinity;
    const marked = calls.some((c) => c.tail === MARK && c.start > site.start && c.start < end);
    return { line: site.line, saveLine: save ? save.line : null, marked };
  });
}

function realLaneSpecs() {
  return fs
    .readdirSync(E2E_DIR)
    .filter((f) => f.endsWith(".spec.js"))
    .filter((f) => parseLaneDirective(path.join(E2E_DIR, f)) === "real");
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
    for (const f of realLaneSpecs()) {
      const sites = postCreationSites(fs.readFileSync(path.join(E2E_DIR, f), "utf8"));
      if (sites.length) creators.push(f);
      for (const site of sites) {
        expect(
          site.marked,
          `${f}:${site.line} opens a posts new-entry form on a live site but does not call ` +
            `${MARK}(page, { title }) before its next Save` +
            (site.saveLine ? ` (line ${site.saveLine})` : "") +
            ` — the post would publish with no robots noindex tag, no sitemap:false and ` +
            `test_fixture:false (#531).`,
        ).toBe(true);
      }
    }
    // Detector-blindness guard: the two known production post creators must be
    // SEEN, so a parser or matcher regression cannot turn this lint vacuous.
    expect(creators).toEqual(
      expect.arrayContaining(["cms-media-roundtrip.spec.js", "cms-publish-loop-prod-mutate.spec.js"]),
    );
  });

  test("the detector sees template-literal URLs, dynamic collections and ordering — and skips comments", () => {
    const head = 'const A = "https://example.com/admin/";\n';
    const unmarked = `${head}async function t(page){ await page.goto(\`\${A}#/collections/posts/new\`); await saveEntry(page); }`;
    const late = `${head}async function t(page){ await page.goto(\`\${A}#/collections/posts/new\`); await saveEntry(page); await ${MARK}(page, { title: "T" }); }`;
    const ok = `${head}async function t(page){ await page.goto(\`\${A}#/collections/posts/new\`); await ${MARK}(page, { title: "T" }); await saveEntry(page); }`;
    const dynamic = `${head}async function t(page, col){ await page.goto(\`\${A}#/collections/\${col}/new\`); await publishViaUi(page); }`;
    const link = `${head}async function t(page){ await collectionNewLink(page, "Post").click(); await saveEntry(page); }`;
    const tags = `${head}async function t(page){ await page.goto(\`\${A}#/collections/tags/new\`); await saveEntry(page); }`;
    const comment = `${head}// await page.goto(\`\${A}#/collections/posts/new\`)\nasync function t(page){ await saveEntry(page); }`;

    expect(postCreationSites(unmarked)).toEqual([{ line: 2, saveLine: 2, marked: false }]);
    expect(postCreationSites(late).map((s) => s.marked)).toEqual([false]);
    expect(postCreationSites(ok).map((s) => s.marked)).toEqual([true]);
    expect(postCreationSites(dynamic).map((s) => s.marked)).toEqual([false]);
    expect(postCreationSites(link).map((s) => s.marked)).toEqual([false]);
    expect(postCreationSites(tags)).toEqual([]);
    expect(postCreationSites(comment)).toEqual([]);
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
