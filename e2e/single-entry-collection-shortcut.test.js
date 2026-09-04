// @lane: local — pure-Node sandbox unit tests for the singleton-collection auto-jump.
/*
 * theme/admin/single-entry-collection-shortcut.js (#329 item 7) skips the
 * pointless one-item list in front of a singleton FILE collection by jumping
 * an editor straight into its only entry. This file drives that decision in a
 * vm sandbox — no browser, no build, no network — the pattern established by
 * admin-publish-routing.test.js and oauth-app-restriction-detector.test.js.
 *
 * WHY A BEHAVIOURAL TEST AND NOT ANOTHER PURE-FS GREP
 * e2e/admin-329-shims.test.js already asserts the file EXISTS, is loaded by all
 * three shells, and still contains its `/new` guard. None of that can see the
 * defect this file was added for: the shim jumped on EVERY arrival at the bare
 * collection route, including the one arrival that is an explicit instruction
 * not to be there.
 *
 * THE DEFECT (jodidaniel.com, reproduced against a local decap-server admin)
 * From `#/collections/site_header/entries/header`, clicking Decap's own back
 * link ("← Writing in Header / Hero collection") sets the hash to
 * `#/collections/site_header`. 700 ms later this shim replaced it with the
 * entry route again. Measured hash timeline: the list held for 600 ms, then
 * bounced — exactly the "flashes briefly, then returns" the report described.
 * The editor could not reach the collection list at all, and no amount of
 * clicking back would ever get there, because every click re-armed the jump.
 *
 * THE RULE THE FIX ENCODES
 * An arrival at the bare collection route FROM an entry of that same
 * collection is the editor asking to come OUT. Every other arrival — a fresh
 * load, the sidebar, a different collection — is the arrival #329 item 7 is
 * about, and still jumps. So the tests below pin BOTH directions: suppressing
 * too much silently un-ships item 7, suppressing too little re-traps the
 * editor.
 *
 * Platform-internal: reads the platform's theme/admin SOURCE tree, which a
 * consumer does not have (it ships only the gem-rendered _site/admin), so this
 * file is registered in PLATFORM_META_SPECS and testIgnored on a consumer lane.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const SHIM = path.join(ADMIN, "single-entry-collection-shortcut.js");
const ORIGIN = "http://localhost:4000/admin/index-local.html";

/**
 * Minimal anchor-set stand-in for the rendered collection list. It answers the
 * two prefix selectors the shim builds, by pulling the quoted prefix back out
 * of the selector string — parsing OUR OWN generated selector, not page source,
 * so the AGENTS.md "AST, never regex, for code shape" rule is not in play here.
 */
function fakeDocument(hrefs) {
  const prefixOf = (sel) => {
    const m = /\[href\^="([^"]*)"\]/.exec(sel);
    if (!m) throw new Error(`unexpected selector shape: ${sel}`);
    return m[1];
  };
  const matching = (sel) =>
    hrefs.filter((h) => h.startsWith(prefixOf(sel))).map((h) => ({ getAttribute: () => h }));
  return {
    querySelectorAll: (sel) => matching(sel),
    querySelector: (sel) => matching(sel)[0] || null,
  };
}

/**
 * Load the shim into a sandbox whose `setTimeout` is captured rather than run,
 * so each test flushes the ~700 ms settle delay explicitly and deterministically.
 */
function loadShim({ hash, hrefs }) {
  const src = fs.readFileSync(SHIM, "utf8");
  const pending = [];
  const replaced = [];
  const location = {
    hash,
    replace(next) {
      replaced.push(next);
      this.hash = next;
    },
  };
  let onHashChange = null;
  const sandbox = {
    window: {
      addEventListener(type, fn) {
        if (type === "hashchange") onHashChange = fn;
      },
      location,
    },
    document: fakeDocument(hrefs),
    location,
    setTimeout(fn) {
      pending.push(fn);
      return pending.length;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  const flush = () => {
    while (pending.length) pending.shift()();
  };

  return {
    location,
    replaced,
    flush,
    /** Drive one hash transition the way a browser would, then settle. */
    navigate(from, to) {
      location.hash = to;
      if (!onHashChange) throw new Error("shim registered no hashchange listener");
      onHashChange({ oldURL: ORIGIN + from, newURL: ORIGIN + to });
      flush();
    },
  };
}

// A singleton FILE collection as Decap renders it: one entry link, no "+ New".
const SINGLETON_HREFS = ["#/collections/site_header/entries/header"];
const ENTRY = "#/collections/site_header/entries/header";
const LIST = "#/collections/site_header";

test.describe("single-entry-collection-shortcut — the arrival that must NOT jump", () => {
  test("backing out of the entry to its own list stays on the list", () => {
    const shim = loadShim({ hash: ENTRY, hrefs: SINGLETON_HREFS });
    shim.flush(); // drain the load-time attempt (hash is an entry route: a no-op)

    shim.navigate(ENTRY, LIST);

    expect(
      shim.replaced,
      "clicking Decap's back link out of a singleton entry must not be undone",
    ).toEqual([]);
    expect(shim.location.hash).toBe(LIST);
  });

  test("publish-baseline-refresh's own entry→list→entry hop is never hijacked", () => {
    // publish-baseline-refresh.js sets the hash to the bare collection route
    // and restores the entry ~60 ms later. That hop arrives from the entry of
    // the same collection, so the same rule makes this shim structurally inert
    // on it rather than relying on out-racing it.
    const shim = loadShim({ hash: ENTRY, hrefs: SINGLETON_HREFS });
    shim.flush();

    shim.navigate(ENTRY, LIST);

    expect(shim.replaced).toEqual([]);
  });
});

test.describe("single-entry-collection-shortcut — the arrivals that must still jump", () => {
  test("a fresh load on the bare collection route jumps to the only entry", () => {
    const shim = loadShim({ hash: LIST, hrefs: SINGLETON_HREFS });

    shim.flush();

    expect(shim.replaced, "#329 item 7: skip the one-item list on arrival").toEqual([ENTRY]);
  });

  test("arriving from a DIFFERENT collection's entry still jumps", () => {
    const shim = loadShim({ hash: "#/collections/expertise/entries/1-health-it", hrefs: SINGLETON_HREFS });
    shim.flush();

    shim.navigate("#/collections/expertise/entries/1-health-it", LIST);

    expect(shim.replaced).toEqual([ENTRY]);
  });

  test("arriving from another collection's LIST still jumps", () => {
    const shim = loadShim({ hash: "#/collections/expertise", hrefs: SINGLETON_HREFS });
    shim.flush();

    shim.navigate("#/collections/expertise", LIST);

    expect(shim.replaced).toEqual([ENTRY]);
  });
});

test.describe("single-entry-collection-shortcut — the guards that predate this fix", () => {
  test("a one-entry FOLDER collection (it renders a + New link) never jumps", () => {
    const shim = loadShim({
      hash: "#/collections/events",
      hrefs: ["#/collections/events/entries/1-a-talk", "#/collections/events/new"],
    });

    shim.flush();

    expect(shim.replaced, "a folder collection is one entry away from having two").toEqual([]);
  });

  test("a multi-entry collection never jumps", () => {
    const shim = loadShim({
      hash: "#/collections/expertise",
      hrefs: ["#/collections/expertise/entries/1-a", "#/collections/expertise/entries/2-b"],
    });

    shim.flush();

    expect(shim.replaced).toEqual([]);
  });
});
