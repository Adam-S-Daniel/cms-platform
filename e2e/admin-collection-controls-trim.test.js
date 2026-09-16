// @lane: local — pure-fs + vm-sandbox unit tests for the collection-list controls trim
/*
 * theme/admin/collection-controls-trim.js removes two Decap collection-list
 * controls an editor on these sites never uses, and which cost a whole row of
 * vertical space above the entry list on a phone:
 *
 *   - the "Sort by" dropdown, and
 *   - the list/grid view-style toggle.
 *
 * Both were reported from a live /admin session on jodidaniel.com, where the
 * sort dropdown offers only Decap's DEFAULT keys (Updated On / the identifier
 * field / Author) because the site's collections declare no `sortable_fields`
 * — i.e. it cannot even sort by the manual `weight` order the sections are
 * actually rendered in.
 *
 * WHY A SHIM AND NOT CONFIG
 * Decap DOES have a config lever for the sort control (`sortable_fields: []`
 * makes `sortableFields.length` zero and the control never mounts), and none
 * for the view-style toggle. Using it would mean adding that key to every
 * collection in the platform's config.base.yml AND in each consumer's
 * site-owned admin/collections.site.yml seam — a per-collection opt-out a new
 * collection silently misses. One shim covers every collection on every
 * consumer, present and future, which is what the request asked for.
 *
 * WHY THE SORT CONTROL IS MATCHED BY LABEL
 * Decap renders Sort, Filter and Group with the SAME component
 * (`ControlButton` inside the shared dropdown `StyledWrapper`) as siblings of
 * the view-style toggle inside `CollectionControlsContainer`, in DOM order
 * [view-style, group?, filter?, sort?]. There is no class, attribute or
 * structural position that separates sort from filter — filter is real and
 * configured (config.base.yml gives posts and projects `view_filters`), so a
 * selector that cannot tell them apart would silently delete a control nobody
 * asked to remove. The button's own visible label is the only discriminator,
 * and matching on it FAILS SAFE: a Decap copy change or a non-English locale
 * makes the match miss and the sort control simply comes back, the same
 * degradation one-door-publish.js documents for its class-substring selectors.
 *
 * The label matcher is therefore the part most worth pinning, and it is pure,
 * so it is exercised here in a vm sandbox — the pattern
 * admin-publish-routing.test.js and oauth-app-restriction-detector.test.js
 * established.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN_DIR = path.resolve(__dirname, "../theme/admin");
const SHIM = "collection-controls-trim.js";

// Editor-facing shells load the trim; index-test.html deliberately does not —
// it is the REHEARSAL surface that must keep rendering Decap's own stock
// collection chrome, the same scope argument one-door-publish.js makes for the
// Status control and the workflow board.
const SHELLS_WITH = ["index.html", "index-local.html"];
const SHELLS_WITHOUT = ["index-test.html"];

// Mirrors admin-shim-load-order.test.js / admin-329-shims.test.js.
function scriptTag(html, basename) {
  const re = new RegExp(
    `<script\\s+src="${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>\\s*</script>`,
  );
  const m = re.exec(html);
  if (!m) return null;
  return { index: m.index, defer: /\bdefer\b/.test(m[1]) };
}

function loadShim() {
  const src = fs.readFileSync(path.join(ADMIN_DIR, SHIM), "utf8");
  // The same inert document stub admin-publish-routing.test.js uses: the
  // registration code runs and finds nothing, MutationObserver is absent so
  // the try/catch takes its no-op branch.
  const sandbox = {
    window: { addEventListener() {} },
    document: {
      readyState: "complete",
      documentElement: {},
      addEventListener() {},
      querySelectorAll: () => [],
    },
    setTimeout: () => 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.__collectionControlsTrim;
  expect(
    api && api.installed,
    `${SHIM} must export window.__collectionControlsTrim`,
  ).toBe(true);
  return api;
}

// ── A minimal DOM, enough to run the shim's own trim pass ──────────────
//
// The matcher test above pins the discriminator; this pins what the shim
// DOES with it. The invariant worth locking is the negative one: a Filter or
// Group dropdown is a sibling of the two controls being removed, is really
// configured (config.base.yml gives posts and projects `view_filters`), and
// must survive untouched — including the case where it is the only thing
// left, which has to keep the row itself on screen.
//
// Hand-rolled rather than jsdom: the shim touches four DOM APIs, the suite
// has no jsdom dependency, and a stub is what lets the test assert on the
// exact style properties written.
function el(className, opts) {
  const o = opts || {};
  const props = new Map();
  const attrs = new Map();
  return {
    className,
    children: o.children || [],
    _button: o.button || null,
    style: {
      setProperty: (k, v) => props.set(k, v),
      getPropertyValue: (k) => props.get(k) || "",
      removeProperty: (k) => props.delete(k),
    },
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    matches(sel) {
      const m = /^\[class\*="(.+)"\]$/.exec(sel);
      return m ? className.includes(m[1]) : false;
    },
    querySelector(sel) {
      // Decap renders the dropdown trigger as <span role="button">, so the
      // shim's fallback selector has to match on the ROLE, not the tag.
      if (sel === '[role="button"], button') return this._button;
      const m = /^\[class\*="(.+)"\]$/.exec(sel);
      if (m && this._button && this._button.className.includes(m[1]))
        return this._button;
      return null;
    },
    get hidden() {
      return props.get("display") === "none";
    },
    get attrs() {
      return attrs;
    },
  };
}

// The two Decap components, as the bundle renders them.
const viewStyleControl = () => el("css-1abc-ViewControlsSection");
const dropdown = (label) =>
  el("css-2def-StyledWrapper", {
    button: el("css-3ghi-ControlButton", { text: label }),
  });

// textContent is what controlLabel() reads off the button.
function withText(node, text) {
  node._button.textContent = text;
  return node;
}
const sortDropdown = () => withText(dropdown(), "Sort by");
const filterDropdown = () => withText(dropdown(), "Filter by");
const groupDropdown = () => withText(dropdown(), "Group by");

// Run the shim over a set of containers, returning a re-run hook so a second
// pass can be driven the way Decap drives one (a route change).
function runShimOver(containers) {
  const src = fs.readFileSync(path.join(ADMIN_DIR, SHIM), "utf8");
  const listeners = [];
  const sandbox = {
    window: {
      addEventListener(type, fn) {
        listeners.push([type, fn]);
      },
    },
    document: {
      readyState: "complete",
      documentElement: {},
      addEventListener() {},
      querySelectorAll: (sel) =>
        sel.includes("CollectionControlsContainer") ? containers : [],
    },
    // No requestAnimationFrame, and a setTimeout that runs its callback
    // straight away, so the shim's coalesced pass completes synchronously.
    setTimeout: (fn) => {
      fn();
      return 0;
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return () => {
    for (const [type, fn] of listeners) if (type === "hashchange") fn();
  };
}

test.describe("collection-list controls trim (sort dropdown + list/grid toggle)", () => {
  test(`${SHIM} exists under theme/admin/`, () => {
    expect(
      fs.existsSync(path.join(ADMIN_DIR, SHIM)),
      `theme/admin/${SHIM} must exist`,
    ).toBe(true);
  });

  for (const shell of SHELLS_WITH) {
    test(`${shell} loads ${SHIM}, deferred`, () => {
      const html = fs.readFileSync(path.join(ADMIN_DIR, shell), "utf8");
      const tag = scriptTag(html, SHIM);
      expect(tag, `${shell} must load <script src="${SHIM}">`).not.toBeNull();
      expect(
        tag.defer,
        `${shell}: ${SHIM} must be loaded with the defer attribute`,
      ).toBe(true);
    });
  }

  for (const shell of SHELLS_WITHOUT) {
    test(`${shell} does NOT load ${SHIM}`, () => {
      const html = fs.readFileSync(path.join(ADMIN_DIR, shell), "utf8");
      expect(
        scriptTag(html, SHIM),
        `${shell} must NOT load ${SHIM} — it is the rehearsal shell and has to keep ` +
          "rendering Decap's own stock collection controls",
      ).toBeNull();
    });
  }

  test("hides by style, never by removing the node", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, SHIM), "utf8");
    expect(
      /setProperty\(\s*"display"/.test(src),
      `${SHIM} must hide with an inline display style`,
    ).toBe(true);
    expect(
      /\.removeChild\(|\.remove\(\)/.test(src),
      `${SHIM} must NOT detach nodes React owns — Decap re-mounts what it finds missing and ` +
        "the observer then re-removes it, the fight loop native-preview-href.js documents",
    ).toBe(false);
  });

  test("hides the view-style toggle and the sort dropdown, and keeps the filter", () => {
    const view = viewStyleControl();
    const filter = filterDropdown();
    const sort = sortDropdown();
    // DOM order as Decap renders it: [view-style, group?, filter?, sort?].
    const container = el("css-4jkl-CollectionControlsContainer", {
      children: [view, filter, sort],
    });

    runShimOver([container]);

    expect(view.hidden, "the list/grid toggle must be hidden").toBe(true);
    expect(sort.hidden, "the Sort by dropdown must be hidden").toBe(true);
    expect(filter.hidden, "the Filter by dropdown must NOT be touched").toBe(
      false,
    );
    expect(
      container.hidden,
      "the controls row must stay while it still holds a filter control",
    ).toBe(false);
    expect(
      view.attrs.get("aria-hidden"),
      "a hidden control leaves the a11y tree too",
    ).toBe("true");
    expect(
      view.attrs.get("tabindex"),
      "a hidden control leaves the tab order too",
    ).toBe("-1");
  });

  test("collapses the whole row when the two controls were all of it", () => {
    const view = viewStyleControl();
    const sort = sortDropdown();
    const container = el("css-4jkl-CollectionControlsContainer", {
      children: [view, sort],
    });

    runShimOver([container]);

    expect(view.hidden).toBe(true);
    expect(sort.hidden).toBe(true);
    expect(
      container.hidden,
      "with nothing left to show the row must go too — otherwise its own 22px margin " +
        "plus the 20px gap its parent reserves survive as 42px of empty space",
    ).toBe(true);
  });

  test("keeps a group control, and the row, when the collection has no sortable fields", () => {
    // `sortable_fields: []` on a collection means Decap never mounts the sort
    // dropdown at all, so the LAST child of the row is the group control. This
    // is the case a structural "hide the last child" rule would get wrong.
    const view = viewStyleControl();
    const group = groupDropdown();
    const container = el("css-4jkl-CollectionControlsContainer", {
      children: [view, group],
    });

    runShimOver([container]);

    expect(view.hidden).toBe(true);
    expect(group.hidden, "the Group by dropdown must NOT be touched").toBe(
      false,
    );
    expect(container.hidden).toBe(false);
  });

  test("a row collapsed on one route re-opens when the next one has a filter", () => {
    const view = viewStyleControl();
    const sort = sortDropdown();
    const container = el("css-4jkl-CollectionControlsContainer", {
      children: [view, sort],
    });

    const rerun = runShimOver([container]);
    expect(container.hidden, "collapsed on the first collection").toBe(true);

    // React reuses the container node across a route change to a collection
    // that DOES have a filter. Without the un-hide branch the filter would be
    // configured, rendered, and invisible.
    container.children = [view, filterDropdown()];
    rerun();

    expect(
      container.hidden,
      "the row must come back for the filter control",
    ).toBe(false);
    expect(
      container.attrs.has("aria-hidden"),
      "and leave the a11y tree unchanged",
    ).toBe(false);
  });

  test("the sort label matcher accepts only the sort control's own label", () => {
    const { isSortControlLabel } = loadShim();

    // Decap 3.15.1's en `collection.collectionTop.sortBy`, plus the whitespace
    // and casing a DOM textContent read can hand it.
    for (const yes of [
      "Sort by",
      "  Sort by  ",
      "sort by",
      "SORT BY",
      "Sort  by",
    ]) {
      expect(isSortControlLabel(yes), `${JSON.stringify(yes)} must match`).toBe(
        true,
      );
    }

    // The two SIBLING controls this must never hide are the whole reason the
    // matcher exists, so they are the first negatives.
    for (const no of [
      "Filter by",
      "Group by",
      "",
      "   ",
      null,
      undefined,
      "Sort",
      "Sort by date",
      "Resort by",
      "Updated On",
    ]) {
      expect(
        isSortControlLabel(no),
        `${JSON.stringify(no)} must NOT match`,
      ).toBe(false);
    }
  });
});
