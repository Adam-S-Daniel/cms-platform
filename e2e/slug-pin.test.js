// @lane: local — pure-Node behavioral test for slug-pin.js (vm sandbox, real live-url-derive.js)
/*
 * A post's public address is `/blog/<slug>/`, where Jekyll takes <slug> from
 * the front-matter `slug:` if set, else from the FILE NAME. Decap names the
 * file from the title at the FIRST save and never renames it. So a post whose
 * title is edited after that first save keeps its old file-name address, while
 * every admin surface (the live-URL banner, Live Preview) and the
 * cms-preview-url / console-clean checks derive the address from the NEW
 * title — they 404, and the publish is blocked. That is adamdaniel.ai#3857:
 * "…on Coding Agents" became "…on Unlocking Coding Agents' Potential".
 *
 * slug-pin.js closes it by filling an EMPTY URL Slug in Decap's public
 * `preSave` event, so the address is written down once and a later title
 * edit cannot move it:
 *   - a NEW post takes it from its title (what the file name will be);
 *   - an EXISTING post takes it from its file name (the address it already
 *     has), never from a title that may have changed since.
 * An explicit slug is never touched.
 *
 * The slugify is the REAL window.LiveURL.slugify, loaded from
 * live-url-derive.js — the one slugify-parity.test.js locks to Jekyll's.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const LIVE_URL_DERIVE = fs.readFileSync(path.join(ADMIN, "live-url-derive.js"), "utf8");
const SLUG_PIN = fs.readFileSync(path.join(ADMIN, "slug-pin.js"), "utf8");

// The two Immutable.Map methods the handler may use, with Immutable's
// persistent semantics: set() returns a NEW map and leaves the old one alone.
class IMap {
  constructor(obj) {
    this.o = { ...obj };
  }
  get(k) {
    return this.o[k];
  }
  set(k, v) {
    return new IMap({ ...this.o, [k]: v });
  }
  toJS() {
    return { ...this.o };
  }
}

function entry({ collection = "posts", newRecord = false, slug = "", data = {} }) {
  return new IMap({ collection, newRecord, slug, data: new IMap(data) });
}

/**
 * Load both shims. `withLiveUrl: false` simulates live-url-derive.js failing
 * to load. `head` answers the new-post address probe: a status number, "throw",
 * or "hang" (never answers until aborted). `timerFires` makes the probe's
 * timeout fire at once (for the "hang" case); by default it never fires, so
 * no test depends on the clock.
 */
function load({
  withLiveUrl = true,
  registerThrows = false,
  head = 404,
  timerFires = false,
  access = "https://example.com",
  destinationOrigin,
  corsEnforced = false,
} = {}) {
  const registered = [];
  const inputListeners = [];
  const heads = [];
  const sandbox = {
    window: {
      location: { hash: "#/collections/posts/new", origin: access },
      CMSHostname: destinationOrigin ? { publicOrigin: () => access, destinationOrigin: () => destinationOrigin } : undefined,
      CMS: {
        registerEventListener(ev) {
          if (registerThrows) throw new Error("Invalid event name");
          registered.push(ev);
        },
      },
      addEventListener() {},
    },
    document: {
      querySelector: () => null,
      addEventListener(type, fn) {
        if (type === "input") inputListeners.push(fn);
      },
    },
    setInterval: (fn) => {
      fn();
      return 1;
    },
    clearInterval() {},
    setTimeout: (fn) => {
      if (timerFires) queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
    AbortController,
    fetch: (url, init) => {
      heads.push({ url: String(url), method: init && init.method });
      if (corsEnforced && new URL(String(url)).origin !== access) {
        return Promise.reject(new TypeError("Cross-origin HEAD response is not readable"));
      }
      if (head === "throw") return Promise.reject(new Error("offline"));
      if (head === "hang") {
        return new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Promise.resolve({ ok: head >= 200 && head < 300, status: head });
    },
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  if (withLiveUrl) vm.runInContext(LIVE_URL_DERIVE, sandbox);
  vm.runInContext(SLUG_PIN, sandbox);
  const preSave = registered.filter((e) => e.name === "preSave");
  // What the editor typing into the URL Slug field looks like to the shim.
  const typeSlug = () => inputListeners.forEach((fn) => fn({ target: { id: "slug-field-3" } }));
  return { preSave, hook: sandbox.window.__slugPin, heads, typeSlug, sandbox };
}

async function runPreSave(e, opts) {
  const { preSave } = load(opts);
  expect(preSave, "slug-pin.js must register exactly one preSave listener").toHaveLength(1);
  return preSave[0].handler({ entry: e, author: { login: "x", name: "x" } });
}

test.describe("slug-pin.js pins a post's address at save (#3857)", () => {
  test("a NEW post with an empty slug gets its title's slug; every other field is kept", async () => {
    const out = await runPreSave(
      entry({
        newRecord: true,
        slug: undefined,
        data: { title: "Quoting Simon Willison on Unlocking Coding Agents’ Potential", slug: "", body: "b" },
      }),
    );
    expect(out, "the handler must return the new data map").toBeTruthy();
    expect(out.toJS()).toEqual({
      title: "Quoting Simon Willison on Unlocking Coding Agents’ Potential",
      slug: "quoting-simon-willison-on-unlocking-coding-agents-potential",
      body: "b",
    });
  });

  test("a NEW post whose data has no slug key at all still gets one", async () => {
    const out = await runPreSave(entry({ newRecord: true, data: { title: "Hello, World!" } }));
    expect(out.get("slug")).toBe("hello-world");
  });

  test("an EXISTING post with an empty slug keeps its FILE-NAME address, not its edited title's", async () => {
    // The exact #3857 shape: file named from the first title, title edited since.
    const out = await runPreSave(
      entry({
        slug: "2026-09-28-quoting-simon-willison-on-coding-agents",
        data: { title: "Quoting Simon Willison on Unlocking Coding Agents’ Potential", slug: "" },
      }),
    );
    expect(out.get("slug")).toBe("quoting-simon-willison-on-coding-agents");
  });

  test("an EXISTING post's file slug is written VERBATIM — an accented file name keeps its live address", async () => {
    // Decap's default slug encoding is `unicode`, so a title "Café Notes"
    // names the file `…-café-notes`, and normalize_empty_slug.rb makes Jekyll
    // serve it at /blog/café-notes/. Re-slugifying to ASCII ("caf-notes")
    // would MOVE a live page on its next save.
    const out = await runPreSave(entry({ slug: "2026-01-02-café-notes", data: { title: "Café Notes", slug: "" } }));
    expect(out.get("slug")).toBe("café-notes");
  });

  test("a NEW post's slug is Jekyll's slug of the title — accented letters kept, as Jekyll keeps them", async () => {
    const out = await runPreSave(entry({ newRecord: true, data: { title: "Café Notes" } }));
    expect(out.get("slug")).toBe("café-notes");
  });

  test("a whitespace-only slug counts as empty", async () => {
    const out = await runPreSave(entry({ slug: "2026-01-02-hi-there", data: { title: "x", slug: "   " } }));
    expect(out.get("slug")).toBe("hi-there");
  });

  test("an explicit slug is never touched", async () => {
    const { preSave, typeSlug } = load();
    typeSlug(); // the editor typed it on this new post
    const e = entry({ newRecord: true, data: { title: "New Title", slug: "my-chosen-address" } });
    expect(await preSave[0].handler({ entry: e })).toBeUndefined();
    const e2 = entry({ slug: "2026-01-02-old", data: { title: "New Title", slug: "kept" } });
    expect(await runPreSave(e2)).toBeUndefined();
  });

  test("collections other than posts are left alone", async () => {
    for (const collection of ["e2e", "projects", "pages", "tags", "site_settings"]) {
      const e = entry({ collection, newRecord: true, data: { title: "Hello" } });
      expect(await runPreSave(e), `${collection} must not be touched`).toBeUndefined();
    }
  });

  test("nothing derivable (no title, no file slug) leaves the entry alone", async () => {
    expect(await runPreSave(entry({ newRecord: true, data: { title: "" } }))).toBeUndefined();
    expect(await runPreSave(entry({ newRecord: true, data: { title: "’’’" } }))).toBeUndefined();
    expect(await runPreSave(entry({ slug: "", data: { title: "Something" } }))).toBeUndefined();
  });

  test("without window.LiveURL it degrades to a no-op, never an error that blocks Save", async () => {
    const out = await runPreSave(entry({ newRecord: true, data: { title: "Hello" } }), { withLiveUrl: false });
    expect(out).toBeUndefined();
  });

  test("a malformed payload is a no-op, not a thrown error", async () => {
    const { preSave } = load();
    const h = preSave[0].handler;
    expect(await h(undefined)).toBeUndefined();
    expect(await h({})).toBeUndefined();
    expect(await h({ entry: { get: () => undefined } })).toBeUndefined();
  });

  test("a Decap that rejects the event name leaves the shim inert, not the page broken", () => {
    expect(() => load({ registerThrows: true })).not.toThrow();
  });

  test("the #3857 post: after the pin, the checks' derivation equals the address Jekyll serves", async () => {
    // cms-preview-url.spec.js derives slugify(fm.slug || fm.title). Jekyll
    // serves the front-matter slug when set (normalize_empty_slug.rb fills an
    // empty one from the file name). Before the pin these two disagreed —
    // title-derived vs file-derived — and that disagreement was the 404.
    const { hook } = load();
    const fileSlug = "2026-09-28-quoting-simon-willison-on-coding-agents";
    const title = "Quoting Simon Willison on Unlocking Coding Agents’ Potential";
    const jekyllBefore = fileSlug.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    expect(hook.slugify(title), "the pre-fix disagreement this test exists for").not.toBe(jekyllBefore);
    const out = await runPreSave(entry({ slug: fileSlug, data: { title, slug: "" } }));
    expect(hook.slugify(out.get("slug") || title)).toBe(jekyllBefore);
  });

  // ── adversarial-review findings ─────────────────────────────────────────
  test("Duplicate: a new post carrying a COPIED slug gets its own, from its title", async () => {
    // Decap's Duplicate copies every field, the pinned slug included, into a
    // new record on the plain /new route. Keeping it would put the copy at
    // the original's address.
    const out = await runPreSave(entry({ newRecord: true, data: { title: "A Different Title", slug: "the-original" } }));
    expect(out.get("slug")).toBe("a-different-title");
  });

  test("a slug the editor TYPED on this new post is kept", async () => {
    const { preSave, typeSlug } = load();
    typeSlug();
    const out = await preSave[0].handler({
      entry: entry({ newRecord: true, data: { title: "A Title", slug: "my-typed-address" } }),
    });
    expect(out).toBeUndefined();
  });

  test("typing on a DIFFERENT screen does not count for this new post", async () => {
    const { preSave, typeSlug, sandbox } = load();
    sandbox.window.location.hash = "#/collections/posts/entries/2026-01-02-the-original";
    typeSlug();
    sandbox.window.location.hash = "#/collections/posts/new";
    const out = await preSave[0].handler({
      entry: entry({ newRecord: true, data: { title: "A Title", slug: "the-original" } }),
    });
    expect(out.get("slug")).toBe("a-title");
  });

  test("a new post whose address is ALREADY a live page is not pinned onto it", async () => {
    // A same-title post: before this shim, Decap's -1 file suffix kept the two
    // apart on the same day. Pinning the bare title slug would collide.
    const { preSave, heads } = load({ head: 200 });
    const out = await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) });
    expect(heads).toEqual([{ url: "https://example.com/blog/hello/", method: "HEAD" }]);
    expect(out).toBeUndefined();
  });

  test("the address probe failing, or hanging, never blocks Save — it pins", async () => {
    let { preSave } = load({ head: "throw" });
    expect((await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) })).get("slug")).toBe(
      "hello",
    );
    ({ preSave } = load({ head: "hang", timerFires: true }));
    expect((await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) })).get("slug")).toBe(
      "hello",
    );
  });

  test("an EXISTING post is never probed — its address is already its file name", async () => {
    const { preSave, heads } = load({ head: 200 });
    const out = await preSave[0].handler({ entry: entry({ slug: "2026-01-02-hello", data: { title: "x", slug: "" } }) });
    expect(out.get("slug")).toBe("hello");
    expect(heads).toEqual([]);
  });
});

for (const [access, destinationOrigin] of [
  ["https://example.com", "https://example.com"],
  ["https://www.example.com", "https://example.com"],
  ["https://d1234abcd.example.net", "https://example.com"],
  ["https://preview-pr7.example.com", "https://example.com"],
  ["https://example.com", "https://preview-pr7.example.com"],
  ["https://preview-pr7.example.com", "https://preview-pr7.example.com"],
  ["http://localhost:4000", "https://example.com"],
  ["http://localhost:4000", "http://localhost:4000"],
]) {
  test(`slug collision probe uses the tab origin: ${access} -> ${destinationOrigin}`, async () => {
    const { preSave, heads } = load({ access, destinationOrigin, head: 200 });
    const out = await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) });
    expect(out).toBeUndefined();
    expect(heads).toEqual([{ url: access + "/blog/hello/", method: "HEAD" }]);
  });
}

test("slug collision probe keeps a readable tab-origin response across a canonical host mismatch", async () => {
  const access = "https://www.example.com";
  const destinationOrigin = "https://example.com";
  const { preSave, heads } = load({ access, destinationOrigin, head: 200, corsEnforced: true });
  const out = await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) });
  expect(out).toBeUndefined();
  expect(new URL(heads[0].url).origin).toBe(access);
  expect(heads).toEqual([{ url: access + "/blog/hello/", method: "HEAD" }]);
});

test("slug collision probe keeps the tab origin when destinationOrigin is unavailable", async () => {
  const { preSave, heads, sandbox } = load({ access: "http://localhost:4000" });
  sandbox.window.CMSHostname = { publicOrigin: () => "https://example.com" };
  await preSave[0].handler({ entry: entry({ newRecord: true, data: { title: "Hello" } }) });
  expect(heads).toEqual([{ url: "http://localhost:4000/blog/hello/", method: "HEAD" }]);
});
