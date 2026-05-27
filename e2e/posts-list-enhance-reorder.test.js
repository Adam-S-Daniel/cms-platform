// @lane: local — pure-Node behavioural unit test for posts-list-enhance.js
/*
 * Regression guard for the reorderFixturesLast() fixed-point property.
 *
 * admin/posts-list-enhance.js hides the E2E-canary posts by moving their
 * <li>s to the end of the Posts list, then re-runs on every Decap React
 * re-render via a document.body MutationObserver. The original
 * "append every fixture whose li !== lastElementChild" form never reached
 * a fixed point when ≥2 fixtures were present: it moved the second-to-last
 * fixture to last on every pass, swapping the final two forever. Each move
 * mutated the list, re-firing the observer → scheduleAugment() →
 * reorderFixturesLast() again — a ~60 Hz reorder/reflow loop that pegged
 * the admin main thread. At the 3K admin viewport the reflow cost was high
 * enough that Decap never settled and the post-login sidebar collection
 * links never became visible within the e2e step budget, taking out the
 * whole chromium-desktop-3k admin lane (and webkit-iphone16).
 *
 * The runtime is exercised in a browser by cms-posts-list-runtime.spec.js,
 * but that lane only runs when admin paths change and is expensive; this
 * test loads the REAL source in a vm sandbox over a minimal DOM, captures
 * its MutationObserver callback, and drives observe→augment cycles to
 * assert the list reaches DOM quiescence with 1, 2 and 3 fixtures present.
 * With the looping form it never settles and this test times out the
 * cycle budget; with the idempotent form it settles in one corrective pass.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC = fs.readFileSync(path.resolve(__dirname, "../admin/posts-list-enhance.js"), "utf8");

// ── Minimal DOM ─────────────────────────────────────────────────────
function makeDom() {
  let mutations = 0;
  const bump = () => {
    mutations++;
  };

  class El {
    constructor(tag) {
      this.tagName = (tag || "div").toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.attributes = {};
      this._text = "";
      this._html = "";
      this.style = { setProperty() {}, cssText: "" };
      const set = new Set();
      this.classList = {
        toggle: (c, on) => {
          const want = on === undefined ? !set.has(c) : !!on;
          if (want) set.add(c);
          else set.delete(c);
        },
        add: (c) => set.add(c),
        remove: (c) => set.delete(c),
        contains: (c) => set.has(c),
      };
    }
    get id() {
      return this.attributes.id || "";
    }
    set id(v) {
      this.attributes.id = v;
    }
    get className() {
      return this.attributes.class || "";
    }
    set className(v) {
      this.attributes.class = v;
    }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    }
    getAttribute(k) {
      return k in this.attributes ? this.attributes[k] : null;
    }
    removeAttribute(k) {
      delete this.attributes[k];
    }
    get lastElementChild() {
      return this.children[this.children.length - 1] || null;
    }
    get nextElementSibling() {
      const p = this.parentNode;
      if (!p) return null;
      return p.children[p.children.indexOf(this) + 1] || null;
    }
    _detach(node) {
      if (node.parentNode) {
        const c = node.parentNode.children;
        const i = c.indexOf(node);
        if (i >= 0) c.splice(i, 1);
      }
    }
    appendChild(node) {
      this._detach(node);
      node.parentNode = this;
      this.children.push(node);
      bump();
      return node;
    }
    insertBefore(node, ref) {
      this._detach(node);
      node.parentNode = this;
      if (ref == null) this.children.push(node);
      else {
        const i = this.children.indexOf(ref);
        if (i < 0) this.children.push(node);
        else this.children.splice(i, 0, node);
      }
      bump();
      return node;
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      if (this.children.length) return this.children.map((c) => c.textContent).join("");
      return this._text;
    }
    set innerHTML(v) {
      this._html = String(v);
      this.children = [];
      bump();
    }
    get innerHTML() {
      return this._html;
    }
    closest(sel) {
      let n = this;
      while (n) {
        if (n._matches(sel)) return n;
        n = n.parentNode;
      }
      return null;
    }
    _matches(sel) {
      if (sel === "ul") return this.tagName === "UL";
      if (sel === "li") return this.tagName === "LI";
      if (sel[0] === ".") return this.className.split(/\s+/).includes(sel.slice(1));
      return false;
    }
    _walk(out) {
      for (const c of this.children) {
        out.push(c);
        c._walk(out);
      }
      return out;
    }
    querySelector(sel) {
      return this._qsa(sel)[0] || null;
    }
    querySelectorAll(sel) {
      return this._qsa(sel);
    }
    _qsa(sel) {
      let m = /^:scope\s*>\s*\.(\S+)$/.exec(sel);
      if (m) return this.children.filter((c) => c.className.split(/\s+/).includes(m[1]));
      const all = this._walk([]);
      m = /^a\[href\*=["'](.+)["']\]$/.exec(sel);
      if (m)
        return all.filter(
          (e) => e.tagName === "A" && (e.getAttribute("href") || "").includes(m[1]),
        );
      m = /^\[role=["'](\w+)["']\]$/.exec(sel);
      if (m) return all.filter((e) => e.getAttribute("role") === m[1]);
      if (sel[0] === "#") return all.filter((e) => e.id === sel.slice(1));
      return all.filter((e) => e.tagName === sel.toUpperCase());
    }
  }

  return {
    El,
    mutations: () => mutations,
    resetMutations: () => {
      mutations = 0;
    },
  };
}

function store() {
  const m = {};
  return {
    getItem: (k) => (k in m ? m[k] : null),
    setItem: (k, v) => {
      m[k] = String(v);
    },
    removeItem: (k) => {
      delete m[k];
    },
  };
}

/**
 * Build a Posts-list DOM from `posts` ([{slug, fix}]), load the real
 * source over it, then drive up to MAX observe→augment cycles. Returns the
 * per-cycle mutation counts, whether it converged (a 0-mutation cycle),
 * the final <li> order, and the entry-card count.
 */
function runEnhance(posts) {
  const dom = makeDom();
  const { El } = dom;

  const body = new El("body");
  const head = new El("head");
  const container = new El("div");
  body.appendChild(container);
  const ul = new El("ul");
  container.appendChild(ul);

  for (const p of posts) {
    const li = new El("li");
    const a = new El("a");
    a.setAttribute("href", "#/collections/posts/entries/" + p.slug);
    const h2 = new El("h2");
    h2.textContent = (p.fix ? "E2E " : "Real ") + p.slug + " (2026-05-12)";
    a.appendChild(h2);
    li.appendChild(a);
    ul.appendChild(li);
  }
  dom.resetMutations();

  const rafQ = [];
  let observerCb = null;
  const sandbox = {
    console: { warn() {}, log() {}, error() {} },
    JSON,
    Date,
    decodeURIComponent,
    encodeURIComponent,
    RegExp,
    Object,
    Array,
    String,
    Math,
    Promise,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    requestAnimationFrame: (fn) => {
      rafQ.push(fn);
      return rafQ.length;
    },
    localStorage: store(),
    sessionStorage: store(),
    MutationObserver: class {
      constructor(cb) {
        observerCb = cb;
      }
      observe() {}
      disconnect() {}
    },
  };
  sandbox.window = sandbox;
  sandbox.document = {
    readyState: "complete",
    body,
    head,
    getElementById: (id) => body._qsa("#" + id)[0] || head._qsa("#" + id)[0] || null,
    querySelectorAll: (sel) => body._qsa(sel),
    querySelector: (sel) => body._qsa(sel)[0] || null,
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };
  sandbox.location = { hash: "#/collections/posts" };
  sandbox.window.location = sandbox.location;
  sandbox.addEventListener = () => {};

  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  const MAX = 40;
  const perCycle = [];
  let converged = false;
  for (let i = 0; i < MAX; i++) {
    dom.resetMutations();
    while (rafQ.length) rafQ.shift()();
    if (observerCb) observerCb();
    perCycle.push(dom.mutations());
    if (dom.mutations() === 0) {
      converged = true;
      break;
    }
  }

  const order = ul.children.map((li) => {
    const a = li._qsa('a[href*="#/collections/posts/entries/"]')[0];
    const slug = /entries\/(.+)$/.exec(a.getAttribute("href"))[1];
    return { slug, fix: posts.find((p) => p.slug === slug).fix };
  });

  return { perCycle, converged, order, cardCount: ul.children.length };
}

const REAL = (n) => ({ slug: "2026-05-1" + n + "-real-post-" + n, fix: false });
const FIX = (n) => ({ slug: "2099-01-0" + n + "-e2e-canary-" + n, fix: true });

test.describe("posts-list-enhance.js — reorderFixturesLast fixed point", () => {
  for (const count of [1, 2, 3]) {
    test(`settles with ${count} fixture(s) present (no infinite reorder loop)`, () => {
      const posts = [REAL(1), FIX(1)];
      for (let i = 2; i <= count; i++) posts.push(FIX(i));
      posts.push(REAL(2));
      const { perCycle, converged, cardCount } = runEnhance(posts);
      expect(
        converged,
        `reorder never reached a fixed point — mutations/cycle: ${JSON.stringify(perCycle)}. ` +
          "A non-converging list means the document.body MutationObserver keeps re-firing " +
          "augment() (the 3K admin-lane main-thread loop).",
      ).toBe(true);
      // Once settled, every subsequent pass is a pure no-op.
      expect(perCycle[perCycle.length - 1]).toBe(0);
      expect(cardCount, "entry cards must never be removed (augment, not replace)").toBe(
        posts.length,
      );
    });
  }

  test("moves all fixtures to a contiguous tail in stable relative order", () => {
    const posts = [REAL(1), FIX(1), REAL(2), FIX(2), FIX(3)];
    const { converged, order } = runEnhance(posts);
    expect(converged).toBe(true);
    const fixFlags = order.map((o) => o.fix);
    // Reals first, then fixtures — fixtures form one contiguous suffix.
    expect(fixFlags).toEqual([false, false, true, true, true]);
    // Fixtures keep their original relative order.
    expect(order.filter((o) => o.fix).map((o) => o.slug)).toEqual([
      "2099-01-01-e2e-canary-1",
      "2099-01-02-e2e-canary-2",
      "2099-01-03-e2e-canary-3",
    ]);
  });
});
