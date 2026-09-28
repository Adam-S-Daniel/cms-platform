// @lane: local — pure-Node behavioural test for slug-pin.js (vm sandbox, real live-url-derive.js)
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

/** Load both shims; `withLiveUrl: false` simulates live-url-derive.js failing to load. */
function load({ withLiveUrl = true, registerThrows = false } = {}) {
  const registered = [];
  const sandbox = {
    window: {
      location: { hash: "" },
      CMS: {
        registerEventListener(ev) {
          if (registerThrows) throw new Error("Invalid event name");
          registered.push(ev);
        },
      },
    },
    document: { querySelector: () => null },
    setInterval: (fn) => {
      fn();
      return 1;
    },
    clearInterval() {},
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  if (withLiveUrl) vm.runInContext(LIVE_URL_DERIVE, sandbox);
  vm.runInContext(SLUG_PIN, sandbox);
  const preSave = registered.filter((e) => e.name === "preSave");
  return { preSave, hook: sandbox.window.__slugPin };
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

  test("a whitespace-only slug counts as empty", async () => {
    const out = await runPreSave(entry({ slug: "2026-01-02-hi-there", data: { title: "x", slug: "   " } }));
    expect(out.get("slug")).toBe("hi-there");
  });

  test("an explicit slug is never touched", async () => {
    const e = entry({ newRecord: true, data: { title: "New Title", slug: "my-chosen-address" } });
    expect(await runPreSave(e)).toBeUndefined();
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

  test("the pinned slug is what the cms-preview-url contract derives — the #3857 check now passes", async () => {
    // cms-preview-url.spec.js derives slugify(fm.slug || fm.title) and expects
    // it to be served; Jekyll serves front-matter slug, else the file name.
    const { hook } = load();
    const fileSlug = "2026-09-28-quoting-simon-willison-on-coding-agents";
    const title = "Quoting Simon Willison on Unlocking Coding Agents’ Potential";
    const out = await runPreSave(entry({ slug: fileSlug, data: { title, slug: "" } }));
    const contract = hook.slugify(out.get("slug") || title);
    const jekyllServes = out.get("slug"); // front-matter slug wins in Jekyll
    expect(contract).toBe(jekyllServes);
  });
});
