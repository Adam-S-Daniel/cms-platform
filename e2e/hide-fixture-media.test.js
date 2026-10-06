// @lane: local — pure-Node sandbox unit tests for hide-fixture-media.js and the #652 probe-asset invariants
/*
 * Issue #652: the committed preview-media sentinel
 * (assets/images/uploads/e2e-preview-media-probe.png) shows up in the media
 * library / in-entry picker beside "Delete selected". hide-fixture-media.js
 * hides cards for `e2e-preview-*` files. These tests drive the shim in a vm
 * sandbox with a fake DOM and pin three invariants:
 *   - fixture cards are hidden, real images and the roundtrip spec's own
 *     `e2e-media-roundtrip-*` upload are NOT;
 *   - the shim is loaded (deferred) by all three admin shells;
 *   - no e2e spec UPLOADS the probe (it is a committed sentinel, so there is
 *     no cleanup to skip: the leak is the file's location, not a spec).
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { test, expect } = require("./base");
const { hasCssDisplayNoneHide, removeChildReceivers } = require("./admin-shim-rules");

const ADMIN_DIR = path.resolve(__dirname, "../theme/admin");
const SHIM = "hide-fixture-media.js";
const SHIM_SOURCE = fs.readFileSync(path.join(ADMIN_DIR, SHIM), "utf8");

function fakeCard(name) {
  const styles = {};
  const attrs = {};
  const card = {
    nodeType: 1,
    className: "e2etv5a6 css-1abc-Card",
    parentElement: null,
    style: {
      setProperty: (k, v, p) => (styles[k] = [v, p]),
      removeProperty: (k) => delete styles[k],
    },
    hasAttribute: (a) => a in attrs,
    setAttribute: (a, v) => (attrs[a] = v),
    removeAttribute: (a) => delete attrs[a],
    styles,
    attrs,
  };
  const label = {
    nodeType: 1,
    className: "e2etv5a1 css-9xyz-CardText",
    textContent: `  ${name} `,
    parentElement: card,
  };
  return { card, label };
}

function boot(names) {
  const cards = names.map(fakeCard);
  const observers = [];
  const sandbox = {
    MutationObserver: class {
      constructor(cb) {
        observers.push(cb);
      }
      observe() {}
    },
    document: {
      readyState: "complete",
      documentElement: {},
      addEventListener: () => {},
      querySelectorAll: (sel) => (sel.includes("CardText") ? cards.map((c) => c.label) : []),
    },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);
  return { cards, observers };
}

test.describe("hide-fixture-media.js (unit, #652)", () => {
  test("hides the preview-media probe card, leaves real images and the roundtrip upload", () => {
    const { cards } = boot([
      "e2e-preview-media-probe.png",
      "hero.jpg",
      "e2e-media-roundtrip-123.png",
      "E2E-PREVIEW-other.png",
    ]);
    const hidden = cards.map((c) => "display" in c.card.styles);
    expect(hidden).toEqual([true, false, false, true]);
    expect(cards[0].card.styles.display).toEqual(["none", "important"]);
  });

  test("re-hides a card Decap re-creates on the next observer pass, idempotently", () => {
    const { cards, observers } = boot(["hero.jpg"]);
    expect(observers).toHaveLength(1);
    const fresh = fakeCard("e2e-preview-media-probe.png");
    cards.push(fresh);
    observers[0]();
    observers[0]();
    expect(fresh.card.styles.display).toEqual(["none", "important"]);
    expect(fresh.card.attrs["data-fixture-media-hidden"]).toBe("1");
  });

  test("a card hidden for a fixture is shown again when the virtualized grid reuses it for a real file", () => {
    const { cards, observers } = boot(["e2e-preview-media-probe.png"]);
    expect(cards[0].card.styles.display).toEqual(["none", "important"]);
    cards[0].label.textContent = "hero.jpg";
    observers[0]();
    expect(cards[0].card.styles.display).toBeUndefined();
    expect(cards[0].card.attrs["data-fixture-media-hidden"]).toBeUndefined();
    // And it hides again if the node is reused for a fixture once more.
    cards[0].label.textContent = "e2e-preview-media-probe.png";
    observers[0]();
    expect(cards[0].card.styles.display).toEqual(["none", "important"]);
  });

  test("hides with display:none via setProperty and never removes a Decap node", () => {
    expect(hasCssDisplayNoneHide(SHIM_SOURCE)).toBe(true);
    expect(removeChildReceivers(SHIM_SOURCE)).toEqual([]);
  });
});

test.describe("admin shells + probe invariants (#652)", () => {
  for (const shell of ["index.html", "index-local.html", "index-test.html"]) {
    test(`${shell} loads ${SHIM} deferred`, () => {
      const html = fs.readFileSync(path.join(ADMIN_DIR, shell), "utf8");
      const m = new RegExp(`<script\\s+src="${SHIM.replace(".", "\\.")}"([^>]*)>\\s*</script>`).exec(html);
      expect(m, `${shell} must load ${SHIM}`).not.toBeNull();
      expect(/\bdefer\b/.test(m[1])).toBe(true);
    });
  }

  test("no e2e spec uploads the probe: it is a committed sentinel, not a spec upload", () => {
    const offenders = [];
    for (const f of fs.readdirSync(__dirname).filter((n) => /\.spec\.js$/.test(n))) {
      const src = fs.readFileSync(path.join(__dirname, f), "utf8");
      if (!src.includes("e2e-preview-")) continue;
      const ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowHashBang: true });
      let uploads = false;
      walk.simple(ast, {
        CallExpression(n) {
          const c = n.callee;
          if (
            c.type === "MemberExpression" &&
            !c.computed &&
            ["setInputFiles", "uploadFile", "createOrUpdateFile"].includes(c.property.name)
          ) {
            uploads = true;
          }
        },
      });
      if (uploads) offenders.push(f);
    }
    expect(offenders, "a spec that uploads an e2e-preview-* file leaks it into the real uploads folder").toEqual([]);
  });
});
