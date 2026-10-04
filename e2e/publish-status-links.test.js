// @lane: local — pure-Node vm sandbox tests for the publish bar's run links and confirm copy
/*
 * Two editor-bar behaviours on the production shell:
 *
 *   1. "did not pass" (a failed check) and the "waiting for …" phrase (checks
 *      still running) link to the check's workflow run, so whoever the editor
 *      asks for help lands on the run instead of hunting for it. The link is
 *      extra; the sentence still names a person to ask.
 *   2. While publish-button.js's "Put this on …?" confirmation is on screen,
 *      the Draft sentence ("This is saved, but it is not on … yet. Click
 *      Publish to put it on …") is hidden: it repeats the question the editor
 *      is already answering.
 *
 * Three layers, each loaded the way the browser loads it: the pure model
 * (entry-status-model.js) decides WHETHER to link and WHAT phrase; the poller
 * (publish-progress.js) finds WHICH run; the bar (publish-step-hint.js) renders
 * it. No network, no clock: fetch is a stub and `now` is fixed.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const NOW = Date.parse("2026-09-28T12:00:00Z");
const JOB = "https://github.com/owner/repo/actions/runs/123/job/456";

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
      checksUrl: null,
    },
    overrides || {},
  );
}

// ── 1a. The model ──────────────────────────────────────────────────────
test.describe("entry-status-model — which phrase links to the run", () => {
  test("a failed check links “did not pass” to its run", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true, checksFailed: true, checksUrl: JOB }), {
      now: NOW,
    });
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
    expect(got.detailLink).toEqual({ text: "did not pass", href: JOB });
    expect(got.detail).toContain("did not pass");
  });

  test("checks still running link the phrase naming what it is waiting for", () => {
    const m = loadModel();
    const got = m.derive(
      facts({ hasOpenPr: true, armed: true, waitingOn: "one last check (e2e)", checksUrl: JOB }),
      { now: NOW },
    );
    expect(got.badge).toBe(m.BADGE.GOING_LIVE);
    expect(got.detailLink).toEqual({ text: "one last check (e2e)", href: JOB });
    expect(got.detail).toContain("one last check (e2e)");
  });

  test("no run URL means no link — the sentence stands alone", () => {
    const m = loadModel();
    expect(m.derive(facts({ hasOpenPr: true, checksFailed: true }), { now: NOW }).detailLink).toBeNull();
    expect(
      m.derive(facts({ hasOpenPr: true, armed: true, waitingOn: "2 checks" }), { now: NOW }).detailLink,
    ).toBeNull();
  });

  // The URL comes off a GitHub API response, where a check run's details_url
  // is whatever the app that created it chose. Only a github.com https URL is
  // ever put in an href.
  test("a non-GitHub URL is never linked", () => {
    const m = loadModel();
    for (const bad of [
      "javascript:alert(1)",
      "https://example.com/x",
      "http://github.com/owner/repo/actions/runs/1",
      "https://github.com.example.com/x",
    ]) {
      const got = m.derive(facts({ hasOpenPr: true, checksFailed: true, checksUrl: bad }), { now: NOW });
      expect(got.detailLink, bad).toBeNull();
    }
  });

  test("the deploy phase and the other states carry no check link", () => {
    const m = loadModel();
    const cases = [
      facts({ merged: true, deployState: "in_progress", checksUrl: JOB }),
      facts({ hasOpenPr: true, checksUrl: JOB }),
      facts({ hasOpenPr: true, armed: true, mergeConflict: true, checksUrl: JOB }),
      facts({ checksUrl: JOB }),
    ];
    for (const f of cases) expect(m.derive(f, { now: NOW }).detailLink).toBeNull();
  });
});

// ── 1b. The poller ─────────────────────────────────────────────────────
const PR = {
  number: 7,
  html_url: "https://github.com/owner/repo/pull/7",
  head: { ref: "cms/posts/hello", sha: "abc" },
  base: { ref: "main", repo: { default_branch: "main" } },
  labels: [{ name: "cms/ready" }],
};

function run(name, status, conclusion, runId, jobId) {
  return {
    name,
    status,
    conclusion,
    started_at: "2026-09-28T11:55:00Z",
    html_url: `https://github.com/owner/repo/runs/${jobId}`,
    details_url: `https://github.com/owner/repo/actions/runs/${runId}/job/${jobId}`,
  };
}

async function progressFacts(checkRuns, prs) {
  const sandbox = {
    window: { CMS_REPO: "owner/repo", addEventListener() {} },
    // "loading" keeps start() (and its own first tick) from running, so the
    // refresh() below is the one tick and is not swallowed by the in-flight
    // guard.
    document: { hidden: false, readyState: "loading", addEventListener() {} },
    location: { hash: "#/collections/posts/entries/hello" },
    localStorage: { getItem: (k) => (k === "decap-cms-user" ? JSON.stringify({ token: "t" }) : null) },
    setInterval: () => 0,
    fetch: (url) => {
      const u = String(url);
      let body = [];
      if (u.includes("/pulls?state=open")) body = prs || [PR];
      else if (u.includes("/check-runs")) body = { check_runs: checkRuns };
      else if (/\/pulls\/\d+$/.test(u)) body = { mergeable: true };
      else if (u.includes("/actions/runs?")) body = { workflow_runs: [] };
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    },
    console: { info() {}, warn() {} },
    Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(read("publish-progress.js"), sandbox);
  const api = sandbox.window.CMSPublishProgress;
  await api.refresh();
  return api.get().facts;
}

test.describe("publish-progress — which run the link points at", () => {
  test("a failed check points at that check's run", async () => {
    const f = await progressFacts([
      run("build", "completed", "success", 1, 10),
      run("e2e", "completed", "failure", 2, 20),
      run("lint", "in_progress", null, 3, 30),
    ]);
    expect(f.checksFailed).toBe(true);
    expect(f.checksUrl).toBe("https://github.com/owner/repo/actions/runs/2/job/20");
  });

  test("one running check points at its run", async () => {
    const f = await progressFacts([
      run("build", "completed", "success", 1, 10),
      run("e2e", "in_progress", null, 2, 20),
    ]);
    expect(f.checksUrl).toBe("https://github.com/owner/repo/actions/runs/2/job/20");
  });

  test("several running checks in ONE workflow run point at that run", async () => {
    const f = await progressFacts([
      run("e2e (a)", "in_progress", null, 9, 1),
      run("e2e (b)", "queued", null, 9, 2),
    ]);
    expect(f.checksUrl).toBe("https://github.com/owner/repo/actions/runs/9");
  });

  test("running checks across several workflow runs point at the PR's Checks tab", async () => {
    const f = await progressFacts([
      run("e2e", "in_progress", null, 1, 10),
      run("lint", "in_progress", null, 2, 20),
    ]);
    expect(f.checksUrl).toBe("https://github.com/owner/repo/pull/7/checks");
  });

  test("a check whose details_url is off GitHub falls back to its html_url", async () => {
    const r = run("third-party", "completed", "failure", 1, 10);
    r.details_url = "https://ci.example.com/build/1";
    const f = await progressFacts([r]);
    expect(f.checksUrl).toBe("https://github.com/owner/repo/runs/10");
  });

  test("nothing failed and nothing running is no URL", async () => {
    const f = await progressFacts([run("build", "completed", "success", 1, 10)]);
    expect(f.checksUrl).toBeNull();
  });

  test("no open PR is no URL", async () => {
    const f = await progressFacts([], []);
    expect(f.hasOpenPr).toBe(false);
    expect(f.checksUrl).toBeNull();
  });
});

// ── 2. The bar ─────────────────────────────────────────────────────────
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

function loadBar(barFacts, windowExtra = {}) {
  const intervals = [];
  const root = new FakeNode("div");
  const toolbar = new FakeNode("div");
  const save = new FakeNode("button");
  save.disabled = true; // saved: nothing unsaved
  root.appendChild(toolbar);
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
      return null;
    },
    querySelectorAll: () => [],
  };
  const sandbox = {
    window: {
      addEventListener() {},
      CMSPublishProgress: {
        get: () => ({ ready: true, facts: barFacts, prNumber: 7 }),
        subscribe() {},
      },
      ...windowExtra,
    },
    document: doc,
    MutationObserver: class {
      observe() {}
    },
    setInterval(fn) {
      intervals.push(fn);
      return intervals.length;
    },
    setTimeout() {},
    fetch() {
      throw new Error("no network in this test");
    },
    console: { info() {}, warn() {} },
    Date,
    isFinite,
    Math,
    JSON,
  };
  vm.createContext(sandbox);
  for (const f of ["entry-status-model.js", "publish-step-hint.js", "publish-button.js"]) {
    vm.runInContext(read(f), sandbox);
  }
  const tick = () => intervals.forEach((fn) => fn());
  tick();
  return { doc, tick, win: sandbox.window };
}

test.describe("publish-step-hint — the run link", () => {
  test("“did not pass” renders as a link to the run, opening in a new tab", () => {
    const { doc, tick } = loadBar(facts({ hasOpenPr: true, armed: true, checksFailed: true, checksUrl: JOB }));
    const text = doc.getElementById("cms-publish-state-text");
    const links = findAll(text, (n) => n.tagName === "A");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("did not pass");
    expect(links[0].getAttribute("href")).toBe(JOB);
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toMatch(/noopener/);
    expect(text.textContent).toMatch(/^One of the automatic safety checks did not pass, so this/);

    // Steady state must not rebuild the link: this shim observes its own
    // subtree, and a rebuild per tick feeds that observer.
    tick();
    tick();
    expect(findAll(text, (n) => n.tagName === "A")[0]).toBe(links[0]);
  });

  test("the running phrase links while checks are in flight", () => {
    const { doc } = loadBar(
      facts({ hasOpenPr: true, armed: true, waitingOn: "one last check (e2e)", checksUrl: JOB }),
    );
    const text = doc.getElementById("cms-publish-state-text");
    const links = findAll(text, (n) => n.tagName === "A");
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toBe("one last check (e2e)");
    expect(links[0].getAttribute("href")).toBe(JOB);
  });

  test("with no run URL the sentence is plain text", () => {
    const { doc } = loadBar(facts({ hasOpenPr: true, armed: true, checksFailed: true }));
    const text = doc.getElementById("cms-publish-state-text");
    expect(findAll(text, (n) => n.tagName === "A")).toHaveLength(0);
    expect(text.textContent).toMatch(/did not pass/);
  });
});

test.describe("publish-step-hint — no Draft sentence under the confirmation", () => {
  test("the Draft sentence hides while “Put this on …?” is on screen, and returns on Cancel", () => {
    const { doc, tick } = loadBar(facts({ hasOpenPr: true }));
    const text = doc.getElementById("cms-publish-state-text");
    const slot = doc.getElementById("cms-publish-state-actions");
    expect(text.textContent).toMatch(/Click Publish/);

    doc.getElementById("cms-publish-button").click();
    tick();
    expect(slot.textContent).toMatch(/^Put this on /);
    expect(text.textContent).toBe("");
    expect(text.style.getPropertyValue("display")).toBe("none");

    const cancel = findAll(slot, (n) => n.tagName === "BUTTON" && n.textContent === "Cancel")[0];
    cancel.click();
    tick();
    expect(text.textContent).toMatch(/Click Publish/);
    expect(text.style.getPropertyValue("display")).not.toBe("none");
  });

  // Only the Draft sentence repeats the question. A Needs-attention sentence
  // says WHY the last publish stopped, which the editor still needs while
  // deciding whether to try again.
  test("a Needs-attention sentence stays while the confirmation is on screen", () => {
    const { doc, tick } = loadBar(facts({ hasOpenPr: true, armed: true, checksFailed: true, checksUrl: JOB }));
    doc.getElementById("cms-publish-button").click();
    tick();
    const text = doc.getElementById("cms-publish-state-text");
    expect(text.textContent).toMatch(/did not pass/);
  });
});

// #532: on a preview, publishing merges the edit into that feature branch,
// where it stays, so it reaches the live site when the branch does. The
// confirmation once said "It will NOT go to example.com" — the same false
// promise the cms/preview-only label made.
test.describe("publish-button — the preview confirmation names when the live site gets it", () => {
  test("“Put this on …?” on a preview says the live site comes only with the branch's work", () => {
    const hostname = {
      current: () => "preview-pr0.example.com",
      canonical: () => "example.com",
      options: () => ({ currentHostname: "preview-pr0.example.com", canonicalHostname: "example.com" }),
    };
    const { doc, tick } = loadBar(facts({ hasOpenPr: true, previewOnly: true, baseRef: "claude/x" }), {
      CMSHostname: hostname,
    });
    doc.getElementById("cms-publish-button").click();
    tick();
    const slot = doc.getElementById("cms-publish-state-actions");
    expect(slot.textContent).toContain(
      "Put this on preview-pr0.example.com? It takes about 5 minutes to appear there. " +
        "It will not reach example.com until the work on “claude/x” goes live there.",
    );
    expect(slot.textContent).not.toMatch(/will not go to|NOT go/i);
  });
});

// Review of #558, N2: a cached entry-status-model.js from before laterNote
// still reports preview: true, and the confirmation read "… there. undefined".
test("“Put this on …?” on a preview falls back to the same promise when the model has no laterNote", () => {
  const hostname = {
    current: () => "preview-pr0.example.com",
    canonical: () => "example.com",
    options: () => ({ currentHostname: "preview-pr0.example.com", canonicalHostname: "example.com" }),
  };
  const { doc, tick, win } = loadBar(facts({ hasOpenPr: true, previewOnly: true, baseRef: "claude/x" }), {
    CMSHostname: hostname,
  });
  const real = win.CMSEntryStatus.destination;
  win.CMSEntryStatus.destination = (f, o) => {
    const { laterNote, ...older } = real(f, o);
    return older;
  };
  doc.getElementById("cms-publish-button").click();
  tick();
  const slot = doc.getElementById("cms-publish-state-actions");
  expect(slot.textContent).toContain(
    "Put this on preview-pr0.example.com? It takes about 5 minutes to appear there. " +
      "It will not reach example.com until the work on this branch goes live there.",
  );
  expect(slot.textContent).not.toMatch(/undefined/);
});
