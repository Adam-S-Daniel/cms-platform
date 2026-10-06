/**
 * publish-button.js — Decap's own "Publish now" must publish on the
 * production shell, for ANY editorial-workflow collection, without a Status
 * control (2026-10-05, jodidaniel.com "Expertise").
 *
 * The reported failure: edit an existing entry, save, then Publish →
 * "Publish now" → Decap's native alert `Please update status to "Ready"
 * before publishing.` Decap's Editor `handlePublishEntry` refuses unless the
 * entry's status is the last workflow status, and one-door-publish.js hides
 * the Status control on this shell, so the editor had no way forward.
 *
 * Decap's control is on screen at all only while publish-button.js has no
 * replacement to offer: until publish-progress.js has FOUND the entry's PR.
 * Saving an existing entry fires no `hashchange`, so that lasts up to one
 * 30 s poll. The fix routes a selection in Decap's Publish dropdown through
 * doPublish() (the `cms/ready` label route, with its bounded re-read)
 * before Decap's React handler can reach its Status gate.
 *
 * These tests build the dropdown's real shape (react-aria-menubutton: a
 * wrapper holding the `aria-haspopup` trigger and a menu of
 * `[role="menuitem"]` items) in a tiny fake DOM, load the shim in a vm
 * sandbox, and dispatch events through a model of capture-then-bubble
 * propagation in which Decap's handler is the bubble-phase listener.
 * No browser, no network, no timers: the sandbox's setTimeout runs its
 * callback synchronously.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM_PATH = path.resolve(__dirname, "../theme/admin/publish-button.js");
const READY_LABEL_PATH = "/repos/owner/repo/issues/42/labels";
const DECAP_NOT_READY = 'Please update status to "Ready" before publishing.';

// ── A deliberately tiny DOM ───────────────────────────────────────────
// Selectors supported: compounds of `tag`, `#id`, `[attr="v"]` and
// `[attr*="v"]` — every form publish-button.js's menu route uses.
function parseSelector(sel) {
  const parts = [];
  const re = /#([\w-]+)|\[([\w-]+)(\*?)="([^"]*)"\]|^([a-z]+)/g;
  for (const [, id, name, star, value, tag] of sel.matchAll(re)) {
    if (id) parts.push((el) => el.attrs.id === id);
    else if (name) {
      parts.push((el) =>
        star ? String(el.attrs[name] || "").includes(value) : el.attrs[name] === value,
      );
    } else if (tag) parts.push((el) => el.tag === tag);
  }
  return (el) => parts.every((p) => p(el));
}

class El {
  constructor(tag, attrs = {}, children = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = [];
    this.parentElement = null;
    this.dispatched = [];
    const props = {};
    this.style = {
      getPropertyValue: (n) => props[n] || "",
      setProperty: (n, v) => {
        props[n] = v;
      },
    };
    for (const c of children) this.append(c);
  }
  append(c) {
    c.parentElement = this;
    this.children.push(c);
    return c;
  }
  get textContent() {
    return (this.attrs.text || "") + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.attrs.text = String(v);
    this.children = [];
  }
  get id() {
    return this.attrs.id || "";
  }
  get className() {
    return this.attrs.class || "";
  }
  getAttribute(n) {
    return n in this.attrs ? this.attrs[n] : null;
  }
  setAttribute(n, v) {
    this.attrs[n] = String(v);
  }
  matches(sel) {
    return parseSelector(sel)(this);
  }
  closest(sel) {
    const want = parseSelector(sel);
    for (let el = this; el; el = el.parentElement) if (want(el)) return el;
    return null;
  }
  querySelectorAll(sel) {
    const want = parseSelector(sel);
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (want(c)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  dispatchEvent(ev) {
    this.dispatched.push(ev);
    return true;
  }
}

// One react-aria-menubutton dropdown as Decap renders it: a wrapper whose
// first child holds the trigger and whose second holds the menu.
function menuItems(itemLabels) {
  return itemLabels.map(
    (label) => new El("div", { role: "menuitem", class: "css-1-DropdownItem" }, [new El("span", { text: label })]),
  );
}

function dropdown(triggerClass, itemLabels) {
  const items = menuItems(itemLabels);
  const wrapper = new El("div", { class: "css-1-StyledWrapper" }, [
    new El("div", {}, [
      new El("span", { role: "button", "aria-haspopup": "true", class: `css-1-${triggerClass}` }),
    ]),
    new El("div", { role: "menu" }, [new El("ul", { class: "css-1-DropdownList" }, items)]),
  ]);
  return { wrapper, items, list: wrapper.children[1].children[0] };
}

function buildToolbar() {
  const status = dropdown("StatusButton", ["Draft", "In review", "Ready"]);
  const publish = dropdown("PublishButton", ["Publish now", "Publish and create new", "Publish and duplicate"]);
  const published = dropdown("PublishedToolbarButton", ["Unpublish", "Duplicate"]);
  const root = new El("div", { id: "nc-root" }, [
    new El("div", { class: "css-1-ToolbarContainer" }, [status.wrapper, publish.wrapper, published.wrapper]),
  ]);
  return { root, status, publish, published };
}

const NO_PR = { ready: true, facts: { hasOpenPr: false, armed: false }, prNumber: null, prUrl: null };
const PR_42 = {
  ready: true,
  facts: { hasOpenPr: true, armed: false },
  prNumber: 42,
  prUrl: "https://github.com/owner/repo/pull/42",
};

/**
 * Load the shim against the fake toolbar. `snapshots` script the poller as
 * in publish-button-refresh.test.js: get() returns snapshots[i], each
 * refresh() advances i (the last one sticks).
 */
function load(snapshots, { withSlot = false, holdReads = false } = {}) {
  const held = [];
  const src = fs.readFileSync(SHIM_PATH, "utf8");
  const dom = buildToolbar();
  const slot = withSlot ? dom.root.append(new El("span", { id: "cms-publish-state-actions" })) : null;
  if (slot) {
    slot.firstChild = null;
    slot.removeChild = () => {};
    slot.appendChild = () => {};
  }
  let i = 0;
  const fetchCalls = [];
  const alerts = [];
  const listeners = [];
  const progress = {
    get: () => snapshots[Math.min(i, snapshots.length - 1)],
    refresh: () => {
      i += 1;
      return Promise.resolve();
    },
    getToken: () => "t0k3n",
    subscribe: () => () => {},
  };
  class KeyboardEvent {
    constructor(type, init) {
      this.type = type;
      Object.assign(this, init);
    }
  }
  const document = {
    readyState: "complete",
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture: capture === true || Boolean(capture && capture.capture) });
    },
    getElementById: (id) => (id === "cms-publish-state-actions" ? slot : null),
    querySelector: (sel) => dom.root.querySelector(sel),
    querySelectorAll: (sel) => dom.root.querySelectorAll(sel),
    documentElement: dom.root,
    createElement: (tag) => new El(tag),
  };
  const observers = [];
  class MutationObserver {
    constructor(fn) {
      this.fn = fn;
      observers.push(this);
    }
    observe() {}
  }
  const sandbox = {
    MutationObserver,
    window: {
      CMS_REPO: "owner/repo",
      CMSPublishProgress: progress,
      addEventListener() {},
      alert: (msg) => alerts.push(msg),
    },
    document,
    KeyboardEvent,
    setInterval: () => 0,
    setTimeout: (fn) => {
      fn();
      return 0;
    },
    // Answers every call arm() makes: GET /pulls/<n> (the label read
    // before the re-arm, cms-platform#607) returns a PR with no labels, and
    // the label POST succeeds. `holdReads` parks each GET until release(),
    // which is how a publish is kept "in flight".
    fetch: (url, init) => {
      const method = (init && init.method) || "GET";
      fetchCalls.push({ url: String(url), method, body: init && init.body });
      const res = { ok: true, status: 200, json: () => Promise.resolve({ labels: [] }) };
      if (method === "GET" && holdReads) return new Promise((resolve) => held.push(() => resolve(res)));
      return Promise.resolve(res);
    },
    console: { info() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // Decap's own handler for its Publish dropdown, as the bundle has it:
  // `currentStatus === status.last() ? … : window.alert(onPublishingNotReady)`.
  // The entry is a Draft — the Status control that could change that is
  // hidden on this shell — so reaching this handler IS the reported bug.
  const decapPublishItems = new Set(dom.publish.items);
  const decapHandler = (ev) => {
    const item = ev.target.closest('[role="menuitem"]');
    if (item && decapPublishItems.has(item)) sandbox.window.alert(DECAP_NOT_READY);
  };

  // capture listeners on `document`, then (unless stopped) React's
  // bubble-phase listener on its root container.
  function fire(type, target, extra = {}) {
    const ev = {
      type,
      target,
      defaultPrevented: false,
      stopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      stopImmediatePropagation() {
        this.stopped = true;
      },
      ...extra,
    };
    for (const l of listeners) if (l.capture && l.type === type && !ev.stopped) l.fn(ev);
    if (!ev.stopped && (type === "click" || (type === "keydown" && (ev.key === "Enter" || ev.key === " ")))) {
      decapHandler(ev);
    }
    return ev;
  }

  const release = () => {
    while (held.length) held.shift()();
  };
  // react-aria-menubutton unmounts the menu on close and mounts fresh item
  // nodes on open: model that, then deliver the observer's childList record.
  function remount(dd, labels) {
    dd.list.children = [];
    dd.items = menuItems(labels);
    for (const it of dd.items) dd.list.append(it);
    for (const o of observers) o.fn([{ addedNodes: dd.items }]);
    return dd.items;
  }
  return { api: sandbox.window.__publishButton, dom, fire, fetchCalls, alerts, release, remount, observers };
}

function armPosts(fetchCalls) {
  return fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith(READY_LABEL_PATH));
}

// doPublish() is async and fire-and-forget from the listener; drain the
// microtask queue (no wall clock involved).
async function settle() {
  for (let n = 0; n < 50; n++) await Promise.resolve();
}

test.describe("publish-button — Decap's Publish menu goes through the cms/ready route", () => {
  test("'Publish now' on a just-saved Draft (poller not caught up) arms the PR instead of Decap's Ready alert", async () => {
    const { dom, fire, fetchCalls, alerts } = load([NO_PR, PR_42]);
    const label = dom.publish.items[0].children[0]; // the <span> the editor actually clicks
    const ev = fire("click", label);
    await settle();
    expect(alerts, "Decap's status-gated handler must never run on the production shell").not.toContain(
      DECAP_NOT_READY,
    );
    expect(ev.defaultPrevented && ev.stopped, "the selection is consumed before React sees it").toBe(true);
    const posts = armPosts(fetchCalls);
    expect(posts.length, "exactly one cms/ready POST").toBe(1);
    expect(JSON.parse(posts[0].body)).toEqual({ labels: ["cms/ready"] });
    expect(alerts, "a successful publish raises no dialog at all").toEqual([]);
    expect(
      dom.publish.items[0].dispatched.some((e) => e.type === "keydown" && e.key === "Escape"),
      "the menu is closed the way react-aria-menubutton closes it",
    ).toBe(true);
  });

  test("'Publish now' is routed by click and by Enter/Space", async () => {
    for (const [type, extra] of [
      ["click", {}],
      ["keydown", { key: "Enter" }],
      ["keydown", { key: " " }],
    ]) {
      const { dom, fire, fetchCalls, alerts } = load([PR_42]);
      fire(type, dom.publish.items[0], extra);
      await settle();
      expect(alerts, `${type} ${JSON.stringify(extra)}`).toEqual([]);
      expect(armPosts(fetchCalls).length, `${type} ${JSON.stringify(extra)}`).toBe(1);
    }
  });

  test("a hidden 'create new' / 'duplicate' item that is somehow selected publishes nothing", async () => {
    for (const [type, extra] of [
      ["click", {}],
      ["keydown", { key: "Enter" }],
      ["keydown", { key: " " }],
    ]) {
      for (const idx of [1, 2]) {
        const { dom, fire, fetchCalls, alerts } = load([PR_42]);
        const ev = fire(type, dom.publish.items[idx], extra);
        await settle();
        expect(ev.stopped, "Decap's handler must not run on a hidden item").toBe(true);
        expect(alerts, `${type} item ${idx}`).toEqual([]);
        expect(armPosts(fetchCalls).length, `${type} item ${idx}`).toBe(0);
      }
    }
  });

  test("other dropdowns and other keys pass through to Decap untouched", async () => {
    const { dom, fire, fetchCalls, api } = load([PR_42]);
    for (const item of [...dom.published.items, ...dom.status.items]) {
      const ev = fire("click", item);
      expect(ev.stopped || ev.defaultPrevented, "not Decap's Publish dropdown").toBe(false);
      expect(api.decapPublishMenuItem(item)).toBeNull();
    }
    const ev = fire("keydown", dom.publish.items[0], { key: "ArrowDown" });
    expect(ev.stopped, "menu navigation keys are Decap's").toBe(false);
    const trigger = dom.publish.wrapper.querySelector('[aria-haspopup="true"]');
    expect(fire("click", trigger).stopped, "opening the dropdown is Decap's").toBe(false);
    await settle();
    expect(armPosts(fetchCalls).length).toBe(0);
  });

  test("with genuinely no PR the editor is told why — not asked to set a Status they cannot see", async () => {
    const { dom, fire, fetchCalls, alerts } = load([NO_PR]);
    fire("click", dom.publish.items[0]);
    await settle();
    expect(armPosts(fetchCalls).length).toBe(0);
    expect(alerts.length, "one explanation with no state bar on screen").toBe(1);
    expect(alerts[0]).toContain("could not be published right now");
    expect(alerts[0]).not.toContain("Ready");
  });

  test("a second selection while the first publish is in flight adds cms/ready once", async () => {
    const { dom, fire, fetchCalls, alerts, release } = load([PR_42], { holdReads: true });
    fire("click", dom.publish.items[0]);
    await settle();
    // The first publish is parked on its label read; press again, by click
    // and by keyboard, on two different items.
    fire("click", dom.publish.items[0]);
    fire("keydown", dom.publish.items[1], { key: "Enter" });
    await settle();
    release();
    await settle();
    release();
    await settle();
    expect(alerts, "Decap's handler never runs, and nothing failed").toEqual([]);
    expect(armPosts(fetchCalls).length, "one publish in flight means one cms/ready add").toBe(1);
  });

  test("with the state bar on screen the error stays in the bar, not a dialog", async () => {
    const { dom, fire, alerts, api } = load([NO_PR], { withSlot: true });
    fire("click", dom.publish.items[0]);
    await settle();
    expect(alerts).toEqual([]);
    expect(api.lastError()).toContain("could not be published right now");
  });

  test("the 'create new' and 'duplicate' items are hidden, 'Publish now' is not, and the published dropdown is untouched", async () => {
    const { dom, remount } = load([PR_42]);
    // Menu items mount only while open: nothing is hidden until the observer
    // sees them, so deliver the record the way the page would.
    remount(dom.publish, ["Publish now", "Publish and create new", "Publish and duplicate"]);
    const [now, createNew, duplicate] = dom.publish.items;
    for (const hidden of [createNew, duplicate]) {
      expect(hidden.style.getPropertyValue("display")).toBe("none");
      expect(hidden.style.getPropertyValue("pointer-events")).toBe("none");
      expect(hidden.getAttribute("aria-hidden")).toBe("true");
      expect(hidden.getAttribute("data-one-door-hidden")).toBe("1");
    }
    expect(now.style.getPropertyValue("display"), "'Publish now' stays visible").toBe("");
    expect(now.getAttribute("aria-hidden")).toBeNull();
    for (const item of [...dom.published.items, ...dom.status.items]) {
      expect(item.style.getPropertyValue("display"), item.textContent).toBe("");
      expect(item.getAttribute("aria-hidden"), item.textContent).toBeNull();
    }
    expect(dom.published.items.map((i) => i.textContent)).toEqual(["Unpublish", "Duplicate"]);
  });

  test("the hide is re-applied when Decap re-renders the menu with new nodes", async () => {
    const { dom, remount } = load([PR_42]);
    for (let n = 0; n < 3; n++) {
      const items = remount(dom.publish, ["Publish now", "Publish and create new", "Publish and duplicate"]);
      expect(items[1].style.getPropertyValue("display"), `render ${n}`).toBe("none");
      expect(items[2].style.getPropertyValue("display"), `render ${n}`).toBe("none");
      expect(items[0].style.getPropertyValue("display"), `render ${n}`).toBe("");
    }
  });

  test("an already-hidden item is not written again (no observer feedback loop)", async () => {
    const { dom, remount, observers } = load([PR_42]);
    remount(dom.publish, ["Publish now", "Publish and create new", "Publish and duplicate"]);
    let writes = 0;
    for (const item of dom.publish.items) {
      const set = item.style.setProperty;
      item.style.setProperty = (...a) => {
        writes += 1;
        set(...a);
      };
      const attr = item.setAttribute.bind(item);
      item.setAttribute = (...a) => {
        writes += 1;
        attr(...a);
      };
    }
    // A second childList record over the same, already-hidden nodes.
    for (const o of observers) o.fn([{ addedNodes: dom.publish.items }]);
    expect(writes, "only hidden items exist to re-write; none may be touched").toBe(0);
  });
});
