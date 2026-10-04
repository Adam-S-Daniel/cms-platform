// @lane: local — pure-Node sandbox unit tests for the preview bridge's broadcast payload
/*
 * theme/admin/preview-bridge.js broadcasts each saved entry to /preview/.
 * The payload carries the entry's `slug` beside its collection and fields,
 * because /preview/ needs the entry's editorial branch
 * (`cms/<collection>/<slug>`) to show a not-yet-published upload through
 * draft-media-fallback.js.
 *
 * A NEW entry's postSave carries an empty slug (Decap computes it inside
 * backend.persistEntry, after reading the entry it hands the event), so the
 * bridge re-sends that save once, when Decap replaces the route with
 * #/collections/<c>/entries/<slug>.
 *
 * Loaded in a vm sandbox with a fake BroadcastChannel and a stub window.CMS;
 * the browser-level bridge spec (preview-bridge.spec.js) needs a served site.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../theme/admin/preview-bridge.js"), "utf8");

function boot() {
  const posted = [];
  const windowListeners = {};
  const handlers = {};
  class FakeChannel {
    postMessage(msg) {
      posted.push(JSON.parse(JSON.stringify(msg)));
    }
  }
  const window = {
    location: { origin: "https://site.example.com", hash: "#/collections/posts/new" },
    CMS: {
      registerEventListener({ name, handler }) {
        handlers[name] = handler;
      },
    },
    addEventListener(type, fn) {
      (windowListeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      windowListeners[type] = (windowListeners[type] || []).filter((f) => f !== fn);
    },
  };
  const sandbox = {
    window,
    document: { readyState: "complete", addEventListener() {} },
    BroadcastChannel: FakeChannel,
    Date,
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  expect(typeof handlers.postSave, "the bridge registers postSave").toBe("function");
  function route(hash) {
    window.location.hash = hash;
    for (const fn of [...(windowListeners.hashchange || [])]) fn({});
  }
  return { posted, save: (entry) => handlers.postSave({ entry }), route, windowListeners };
}

// The Immutable.js shape Decap passes: get() and a data holder with toJS().
function immutableEntry(obj) {
  return {
    get: (k) => (k === "data" ? { toJS: () => obj.data } : obj[k]),
  };
}

test.describe("preview-bridge.js payload", () => {
  test("carries collection, slug and fields from an Immutable entry", () => {
    const b = boot();
    b.save(immutableEntry({ collection: "posts", slug: "2026-10-04-hello", data: { title: "Hi" } }));
    expect(b.posted).toEqual([
      { type: "cms-preview-update", collection: "posts", slug: "2026-10-04-hello", fields: { title: "Hi" } },
    ]);
  });

  test("carries the slug from a plain-object entry", () => {
    const b = boot();
    b.save({ collection: "pages", slug: "about", data: { title: "About" } });
    expect(b.posted[0].slug).toBe("about");
    expect(b.posted[0].collection).toBe("pages");
  });

  test("a new entry's save is re-sent once with the slug its route gains", () => {
    const b = boot();
    b.save(immutableEntry({ collection: "posts", slug: "", data: { title: "New" } }));
    expect(b.posted).toHaveLength(1);
    expect(b.posted[0].slug).toBeNull();

    b.route("#/collections/posts/entries/2026-10-04-new");
    expect(b.posted).toHaveLength(2);
    expect(b.posted[1]).toEqual({
      type: "cms-preview-update",
      collection: "posts",
      slug: "2026-10-04-new",
      fields: { title: "New" },
    });

    b.route("#/collections/posts/entries/something-else");
    expect(b.posted).toHaveLength(2);
  });

  test("a route away from the entry sends nothing more", () => {
    const b = boot();
    b.save({ collection: "posts", slug: "", data: {} });
    b.route("#/collections/pages/entries/about");
    b.route("#/collections/posts/entries/late");
    expect(b.posted).toHaveLength(1);
  });
});
