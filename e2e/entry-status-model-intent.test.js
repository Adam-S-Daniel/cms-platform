// @lane: local — pure-Node sandbox tests: publish wording follows the saved `published` value (#636)
/*
 * #636: the editor's publish wording was derived from saved-vs-unsaved and
 * the PR's pipeline state, never from what the publish would DO. So:
 *
 *   A. a new post saved with the toggle off read "Click Publish to put it on
 *      <site>", asked "Put this on <site>?", then said "Going live…" over a
 *      page that stayed a 404;
 *   B. switching a live post off and publishing read "Put this on …?" and
 *      "Going live…" while the publish was taking the post DOWN;
 *   C. a saved edit to a post already on the site read "not on the site yet";
 *   D. the toggle was called "Published" one letter from the Publish button,
 *      and Publish Date's hint said UTC beside a field showing local time.
 *
 * Acceptance: no state says "Published" or "Going live" for a
 * `published: false` entry, and a take-down never says "put this on".
 *
 * Three layers, each loaded the way the browser loads it: the pure model
 * (entry-status-model.js) owns the words; the poller (publish-progress.js)
 * reads `published` / `publishedBefore` / `entryIsNew` off the PR's diff; the
 * bar and the button (publish-step-hint.js, publish-button.js) merge in the
 * saved toggle and render. D's config half is locked in
 * editor-publishing-copy.test.js. No network, no clock.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");
const { API, loadProgress } = require("./publish-progress-harness");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const NOW = Date.parse("2026-10-05T12:00:00Z");
const MIN = 60 * 1000;
const HOST = { now: NOW, currentHostname: "example.com", canonicalHostname: "example.com" };

function read(name) {
  return fs.readFileSync(path.join(ADMIN, name), "utf8");
}

function loadModel() {
  const sandbox = { window: {}, Date, isFinite, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(read("entry-status-model.js"), sandbox);
  return sandbox.window.CMSEntryStatus;
}

function facts(overrides) {
  return Object.assign(
    {
      hasOpenPr: false,
      armed: false,
      merged: false,
      checksFailed: false,
      mergeConflict: false,
      awaitingReviewGate: false,
      deployState: null,
      waitingOn: null,
      startedAt: null,
    },
    overrides || {},
  );
}

// Every pipeline state an entry can be in, by the facts that produce it.
const STATES = {
  draft: { hasOpenPr: true },
  armed: { hasOpenPr: true, armed: true, checks: { total: 3, pending: ["e2e"] }, startedAt: NOW - MIN },
  checksPassed: { hasOpenPr: true, armed: true, checks: { total: 3, pending: [] }, startedAt: NOW - MIN },
  merged: { merged: true, deployState: "pending", startedAt: NOW - MIN },
  deploying: { deployState: "in_progress", startedAt: NOW - MIN },
  checksFailed: { hasOpenPr: true, armed: true, checksFailed: true },
  reviewGate: { hasOpenPr: true, armed: true, awaitingReviewGate: true },
  stalled: { hasOpenPr: true, armed: true, settledSince: NOW - 10 * MIN },
  deployFailed: { deployState: "failure" },
  done: {},
};

const HIDDEN = { published: false };
const TAKEDOWN = { published: false, publishedBefore: true };

test.describe("entry-status-model — what the publish will do", () => {
  test("intentFor reads the saved value, and an unknown before is never a take-down", () => {
    const m = loadModel();
    expect(m.intentFor(facts())).toBe("show");
    expect(m.intentFor(facts({ published: true, publishedBefore: false }))).toBe("show");
    expect(m.intentFor(facts(HIDDEN))).toBe("hidden");
    expect(m.intentFor(facts({ published: false, publishedBefore: null }))).toBe("hidden");
    expect(m.intentFor(facts({ published: false, publishedBefore: false }))).toBe("hidden");
    expect(m.intentFor(facts(TAKEDOWN))).toBe("takedown");
  });

  test("the toggle fills an unknown saved value; the diff's value wins; nothing is mutated", () => {
    const m = loadModel();
    const unknown = facts({ hasOpenPr: true });
    const filled = m.withSavedToggle(unknown, false);
    expect(filled.published).toBe(false);
    expect(filled.hasOpenPr).toBe(true);
    expect(unknown.published, "the poller's snapshot must not be written to").toBeUndefined();
    expect(m.withSavedToggle(facts({ published: true }), false).published).toBe(true);
    expect(m.withSavedToggle(unknown, null)).toBe(unknown);
    expect(m.withSavedToggle(unknown, undefined)).toBe(unknown);
  });

  // The acceptance criterion, swept across every state and both hidden
  // intents rather than spot-checked.
  for (const [intent, extra] of [["hidden", HIDDEN], ["takedown", TAKEDOWN]]) {
    for (const [state, f] of Object.entries(STATES)) {
      test(`${intent}, ${state}: never "Published", "Going live", "Live" or "put this on"`, () => {
        const m = loadModel();
        const got = m.derive(facts({ ...f, ...extra }), HOST);
        const words = `${got.label} | ${got.detail} | ${got.waitingOn || ""}`;
        expect(words).not.toMatch(/Published|going live|gone live|putting (it|this) live/i);
        expect(words).not.toMatch(/put (this|it|them) on/i);
        expect(got.label).not.toMatch(/^Live\b/);
      });
    }
  }

  test("the ordinary publish keeps its words", () => {
    const m = loadModel();
    expect(m.derive(facts(STATES.draft), HOST).detail).toBe(
      "This is saved, but it is not on example.com yet. Click Publish to put it on example.com.",
    );
    expect(m.derive(facts(STATES.armed), HOST).label).toMatch(/^Going live… \(/);
    expect(m.derive(facts(), HOST).label).toBe("Live");
    expect(m.confirmNote(facts(STATES.draft), HOST)).toBeNull();
  });
});

test.describe("A — a new post saved with “Show on site” off", () => {
  const A = { ...HIDDEN, entryIsNew: true };

  test("the Draft bar says it will stay hidden and how to show it", () => {
    const m = loadModel();
    const got = m.derive(facts({ ...STATES.draft, ...A }), HOST);
    expect(got.badge).toBe(m.BADGE.DRAFT);
    expect(got.label).toBe("Draft — will stay hidden");
    expect(got.detail).toBe(
      "This is saved, but it will stay hidden even after you publish, because “Show on site” is off. " +
        "Turn on “Show on site” and Save to show it on example.com.",
    );
  });

  test("the confirmation says it will be saved but stay hidden (the message-only option)", () => {
    const m = loadModel();
    const note = m.confirmNote(facts({ ...STATES.draft, ...A }), HOST);
    expect(note).toBe(
      "This will be saved but stay hidden — “Show on site” is off. " +
        "Turn on “Show on site” and Save to show it on example.com. Publish it hidden?",
    );
  });

  test("in flight it is saving, not going live; done, it is hidden, not Live", () => {
    const m = loadModel();
    const flight = m.derive(facts({ ...STATES.armed, ...A }), HOST);
    expect(flight.badge).toBe(m.BADGE.GOING_LIVE);
    expect(flight.label).toMatch(/^Saving, stays hidden \(about \d+ minutes? left\)$/);
    expect(flight.detail).toMatch(/^This is being saved to example\.com, but it will stay hidden because “Show on site” is off\./);
    const done = m.derive(facts({ ...STATES.done, ...A }), HOST);
    expect(done.badge).toBe(m.BADGE.LIVE);
    expect(done.label).toBe("Hidden — not on the site");
    expect(done.modifiers.map((x) => x.key)).toEqual(["hidden"]);
    expect(done.modifiers[0].detail).toMatch(/Turn “Show on site” on and Save/);
  });
});

test.describe("B — switching a live post off is a take-down", () => {
  test("the Draft bar names it as still on the site and offers to take it off", () => {
    const m = loadModel();
    const got = m.derive(facts({ ...STATES.draft, ...TAKEDOWN }), HOST);
    expect(got.label).toBe("Draft — still on the site");
    expect(got.detail).toBe(
      "“Show on site” is now off, but this is still on example.com. Click Publish to take it off example.com.",
    );
  });

  test("the confirmation uses take-down wording with the time it takes", () => {
    const m = loadModel();
    expect(m.confirmNote(facts({ ...STATES.draft, ...TAKEDOWN }), HOST)).toBe(
      "Take this off example.com? It will disappear in about 5 minutes.",
    );
  });

  test("in flight it is Taking down…, through checks and the deploy; done, it is off the site", () => {
    const m = loadModel();
    for (const state of ["armed", "merged", "deploying"]) {
      const got = m.derive(facts({ ...STATES[state], ...TAKEDOWN }), HOST);
      expect(got.badge, state).toBe(m.BADGE.GOING_LIVE);
      expect(got.label, state).toMatch(/^Taking down… \(/);
      expect(got.detail, state).toMatch(/^This is on its way off example\.com\./);
    }
    const passed = m.derive(facts({ ...STATES.checksPassed, ...TAKEDOWN }), HOST);
    expect(passed.waitingOn).toBe("all 3 automatic safety checks passed; now taking it off the site");
    const done = m.derive(facts({ ...STATES.done, ...TAKEDOWN }), HOST);
    expect(done.label).toBe("Off the site");
  });

  test("a stopped take-down says it has not come off the site", () => {
    const m = loadModel();
    const failed = m.derive(facts({ ...STATES.checksFailed, ...TAKEDOWN }), HOST);
    expect(failed.detail).toMatch(/so this has not come off the site\./);
    const stalled = m.derive(facts({ ...STATES.stalled, ...TAKEDOWN }), HOST);
    expect(stalled.waitingOn).toBe("a person to finish taking this off the site");
  });

  test("on a preview the take-down names the preview and when the live site gets it", () => {
    const m = loadModel();
    const options = { now: NOW, currentHostname: "preview-pr0.example.com", canonicalHostname: "example.com" };
    expect(m.confirmNote(facts({ ...STATES.draft, ...TAKEDOWN, previewOnly: true, baseRef: "x" }), options)).toBe(
      "Take this off preview-pr0.example.com? It will disappear there in about 5 minutes. " +
        "It will not reach example.com until the work on “x” goes live there.",
    );
  });
});

test.describe("C — a saved edit to an entry that already exists", () => {
  test("the Draft bar says the CHANGES are not on the site, not the entry", () => {
    const m = loadModel();
    const got = m.derive(facts({ ...STATES.draft, published: true, entryIsNew: false }), HOST);
    expect(got.label).toBe("Draft — changes not on the site yet");
    expect(got.detail).toBe(
      "Your changes are saved, but they are not on example.com yet. Click Publish to put them on example.com.",
    );
    // A new entry, or one the poller could not tell about, keeps the old words.
    for (const entryIsNew of [true, null, undefined]) {
      expect(m.derive(facts({ ...STATES.draft, entryIsNew }), HOST).label).toBe("Draft — not on the site yet");
    }
  });
});

// ── The poller: published / publishedBefore / entryIsNew off the PR diff ──
const SLUG = "2026-10-05-hello";
const OPEN = `${API}/pulls?state=open&per_page=100`;
const REF = `${API}/git/ref/heads/cms/posts/${SLUG}`;
const TIP = "a1b2000000000000000000000000000000000000";
const FILES = `${API}/pulls/7/files?per_page=100`;

function openPrRoutes(files) {
  return {
    [OPEN]: [
      {
        number: 7,
        html_url: "https://github.com/owner/repo/pull/7",
        head: { ref: `cms/posts/${SLUG}`, sha: TIP },
        base: { ref: "main", repo: { default_branch: "main" } },
        labels: [],
      },
    ],
    [REF]: { object: { sha: TIP } },
    [`${API}/commits/${TIP}/check-runs?per_page=100`]: { check_runs: [] },
    ...(files === undefined ? {} : { [FILES]: files }),
  };
}

function post(status, patch) {
  return { filename: `_posts/${SLUG}.md`, status, patch };
}

async function pollerFacts(files) {
  const { api, calls } = loadProgress(openPrRoutes(files), { now: NOW, hash: `#/collections/posts/entries/${SLUG}` });
  await api.refresh();
  return { facts: api.get().facts, calls, api };
}

test.describe("publish-progress — what the PR changes", () => {
  test("a take-down diff reports published:false over publishedBefore:true", async () => {
    const { facts: f } = await pollerFacts([
      post("modified", "@@ -2,5 +2,5 @@\n title: Hello\n-published: true\n+published: false\n tags: []"),
    ]);
    expect(f.published).toBe(false);
    expect(f.publishedBefore).toBe(true);
    expect(f.entryIsNew).toBe(false);
  });

  test("a new hidden post reports published:false, nothing before, and a new entry", async () => {
    const { facts: f } = await pollerFacts([
      post("added", "@@ -0,0 +1,4 @@\n+---\n+title: Hello\n+published: false\n+---"),
      { filename: "assets/img/hello.png", status: "added" },
    ]);
    expect(f.published).toBe(false);
    expect(f.publishedBefore).toBeNull();
    expect(f.entryIsNew).toBe(true);
  });

  test("an unchanged published line leaves `published` for the saved toggle to fill", async () => {
    const { facts: f } = await pollerFacts([post("modified", "@@ -9,1 +9,1 @@\n-old body\n+new body")]);
    expect("published" in f).toBe(false);
    expect(f.publishedBefore).toBeNull();
    expect(f.entryIsNew).toBe(false);
  });

  test("a body line merely mentioning published, or an image, is not the field", async () => {
    const { facts: f } = await pollerFacts([
      post("modified", "@@ -9,1 +9,1 @@\n-We published: true stories.\n+  published: false"),
      { filename: "assets/img/hello.png", status: "modified", patch: "-published: true" },
    ]);
    expect("published" in f).toBe(false);
    expect(f.publishedBefore).toBeNull();
  });

  test("a failed files read reports nothing (never a take-down) and is retried", async () => {
    const { facts: f, calls, api } = await pollerFacts(undefined);
    expect(calls).toContain(FILES);
    expect(f.publishedBefore).toBeNull();
    expect("published" in f).toBe(false);
    calls.length = 0;
    await api.refresh();
    expect(calls, "an uncached failure is read again next tick").toContain(FILES);
  });

  test("the files read is cached per PR and head sha: one request per save, not per tick", async () => {
    // The harness's load tick read the files; every tick after it, for the
    // same PR and head sha, is answered from the cache.
    const { calls, api } = await pollerFacts([post("modified", "-published: true\n+published: false")]);
    expect(calls).not.toContain(FILES);
    await api.refresh();
    expect(calls).not.toContain(FILES);
    expect(api.get().facts.publishedBefore).toBe(true);
  });
});

// ── The bar and the button, as the editor sees them ───────────────────────
class FakeStyle {
  constructor() {
    this.values = new Map();
  }
  set cssText(value) {
    this.values.clear();
    for (const part of String(value).split(";")) {
      const at = part.indexOf(":");
      if (at > 0) this.values.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
    }
  }
  get cssText() {
    return [...this.values].map(([k, v]) => `${k}:${v}`).join(";");
  }
  getPropertyValue(name) {
    return this.values.get(name) || "";
  }
  setProperty(name, value) {
    this.values.set(name, String(value));
  }
  removeProperty(name) {
    this.values.delete(name);
  }
}

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName ? String(tagName).toUpperCase() : "#text";
    this.children = [];
    this.parentElement = null;
    this.style = new FakeStyle();
    this.attributes = new Map();
    this.listeners = {};
    this.disabled = false;
    this.id = "";
    this._text = "";
  }
  get isConnected() {
    return Boolean(this.parentElement);
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join("") : this._text;
  }
  set textContent(value) {
    this.children = [];
    this._text = value == null ? "" : String(value);
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child, reference) {
    child.parentElement = this;
    const at = reference ? this.children.indexOf(reference) : -1;
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
    return child;
  }
  removeChild(child) {
    const at = this.children.indexOf(child);
    if (at >= 0) this.children.splice(at, 1);
    child.parentElement = null;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  click() {
    for (const fn of this.listeners.click || []) fn();
  }
}

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const c of node.children) findAll(c, pred, out);
  return out;
}

// The production shell's editor: the bar, the button, the model, and
// live-url-derive.js's switch reader over a fake `published` switch.
function loadEditor(barFacts, { toggle, unsaved = false } = {}) {
  const intervals = [];
  const root = new FakeNode("div");
  const toolbar = new FakeNode("div");
  root.appendChild(toolbar);
  const save = new FakeNode("button");
  save.disabled = !unsaved;
  const sw = new FakeNode("button");
  sw.id = "published-field-3";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(toggle));
  const doc = {
    readyState: "complete",
    body: {},
    documentElement: {},
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const n = new FakeNode(null);
      n._text = String(text);
      return n;
    },
    addEventListener() {},
    getElementById: (id) => findAll(root, (n) => n.id === id)[0] || null,
    querySelector: (selector) => {
      if (selector === 'button[class*="SaveButton"]') return save;
      if (selector === '[class*="oolbar"]') return toolbar;
      if (selector === '[role="switch"][id^="published-field-"]') return typeof toggle === "boolean" ? sw : null;
      return null;
    },
    querySelectorAll: () => [],
  };
  const sandbox = {
    window: {
      location: new URL("https://example.com/admin/#/collections/posts/entries/hello"),
      addEventListener() {},
      CMS_SITE_ORIGIN: "https://example.com",
      CMSHostname: {
        destination: () => "example.com",
        canonical: () => "example.com",
        destinationOrigin: () => "https://example.com",
      },
      CMSPublishProgress: {
        get: () => ({ ready: true, facts: barFacts, prNumber: 7 }),
        subscribe() {},
      },
    },
    document: doc,
    URL,
    MutationObserver: class {
      observe() {}
    },
    setInterval(fn) {
      intervals.push(fn);
      return intervals.length;
    },
    setTimeout() {},
    fetch: () => {
      throw new Error("no network in this test");
    },
    console: { info() {}, warn() {} },
    Date: class extends Date {
      static now() {
        return NOW;
      }
    },
    isFinite,
    Math,
    JSON,
  };
  vm.createContext(sandbox);
  for (const f of ["entry-status-model.js", "publish-step-hint.js", "publish-button.js", "live-url-derive.js"]) {
    vm.runInContext(read(f), sandbox);
  }
  const tick = () => intervals.forEach((fn) => fn());
  tick();
  const text = () => doc.getElementById("cms-publish-state").textContent;
  const confirm = () => {
    doc.getElementById("cms-publish-button").click();
    tick();
    return doc.getElementById("cms-publish-state-actions").textContent;
  };
  return { doc, tick, text, confirm };
}

test.describe("the editor — bar and confirmation follow the saved toggle", () => {
  test("A: a saved hidden draft (toggle off) says it stays hidden, and so does the question", () => {
    const ed = loadEditor(facts({ hasOpenPr: true }), { toggle: false });
    expect(ed.text()).toMatch(/^Draft — will stay hidden/);
    expect(ed.text()).not.toMatch(/put it on/i);
    const asked = ed.confirm();
    expect(asked).toMatch(/^This will be saved but stay hidden — “Show on site” is off\./);
    expect(asked).not.toMatch(/Put this on/);
  });

  test("B: a take-down the poller reported asks “Take this off …?”", () => {
    const ed = loadEditor(facts({ hasOpenPr: true, ...TAKEDOWN }), { toggle: false });
    expect(ed.text()).toMatch(/^Draft — still on the site/);
    const asked = ed.confirm();
    expect(asked).toMatch(/^Take this off example\.com\? It will disappear in about 5 minutes\./);
    expect(asked).not.toMatch(/Put this on/);
  });

  test("an ordinary draft (toggle on) still asks “Put this on …?”", () => {
    const ed = loadEditor(facts({ hasOpenPr: true }), { toggle: true });
    expect(ed.text()).toMatch(/^Draft — not on the site yet/);
    expect(ed.confirm()).toMatch(/^Put this on example\.com\?/);
  });

  test("A, after the merge: a hidden entry is not Live and not Going live", () => {
    const ed = loadEditor(facts({ merged: true, deployState: "pending", startedAt: NOW - MIN }), { toggle: false });
    expect(ed.text()).toMatch(/^Saving, stays hidden/);
    const done = loadEditor(facts(), { toggle: false });
    expect(done.text()).toMatch(/^Hidden — not on the site/);
  });

  test("C: an unsaved edit claims nothing about the entry being unpublished", () => {
    const ed = loadEditor(facts({ hasOpenPr: true }), { toggle: true, unsaved: true });
    expect(ed.text()).toMatch(/Save your changes to enable Publish\./);
    expect(ed.text()).not.toMatch(/not published|only you|not on the site/i);
  });
});
