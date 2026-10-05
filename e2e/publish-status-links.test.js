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

function loadBar(barFacts, windowExtra = {}, options = {}) {
  const intervals = [];
  const root = new FakeNode("div");
  const toolbar = new FakeNode("div");
  const save = new FakeNode("button");
  save.disabled = true; // saved: nothing unsaved
  root.appendChild(toolbar);
  if (options.gated) {
    // site-gate-banner.js's banner, present exactly while the site is gated.
    const banner = new FakeNode("div");
    banner.id = "cms-site-gate-banner";
    root.appendChild(banner);
  }
  const doc = {
    readyState: "complete",
    body: {},
    documentElement: {},
    baseURI: (windowExtra.location || new URL("https://example.com/admin/")).href,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const n = new FakeNode(null);
      n._text = String(text);
      return n;
    },
    addEventListener() {},
    getElementById: (id) => findAll(root, (n) => n.id === id)[0] || null,
    querySelector: (selector) => {
      if (options.liveDerive && selector.includes('id^="title-field"')) return { value: "Hello" };
      if (selector === 'button[class*="SaveButton"]') return save;
      if (selector === '[class*="oolbar"]') return toolbar;
      if (options.nativePublish && selector.includes("PublishButton")) return new FakeNode("button");
      if (options.deploy && selector === 'script[src*="deploy-status-pill"]') return {};
      return null;
    },
    querySelectorAll: () => [],
  };
  const sandbox = {
    window: {
      location: windowExtra.location || new URL("https://example.com/admin/"),
      addEventListener() {},
      CMSPublishProgress: {
        get: () => ({ ready: true, facts: barFacts, prNumber: 7 }),
        subscribe() {},
      },
      ...windowExtra,
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
    fetch: options.fetch || (() => {
      throw new Error("no network in this test");
    }),
    console: { info() {}, warn() {} },
    Date: class extends Date { static now() { return NOW; } },
    isFinite,
    Math,
    JSON,
  };
  vm.createContext(sandbox);
  const scripts = [];
  if (options.siteHostname) scripts.push("site-hostname.js");
  if (options.liveDerive) scripts.push("live-url-derive.js");
  if (options.model !== false) scripts.push("entry-status-model.js");
  scripts.push("publish-step-hint.js");
  if (options.publish !== false) scripts.push("publish-button.js");
  for (const f of scripts) vm.runInContext(read(f), sandbox);
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
      destination: () => "preview-pr0.example.com",
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
    destination: () => "preview-pr0.example.com",
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

// Access to the admin shell can be through either host. Publication copy
// follows the destination selected by its served config, including fallback
// paths before the model or config has finished loading (#533).
const HOST_CASES = [
  { access: "preview-pr42.example.com", destination: "example.com" },
  { access: "example.com", destination: "preview-pr42.example.com" },
  { access: "example.com", destination: "example.com" },
  { access: "preview-pr42.example.com", destination: "preview-pr42.example.com" },
];

test.describe("publication destination host (#533)", () => {
  for (const { access, destination } of HOST_CASES) {
    const label = `${access} opened, ${destination} destination`;
    const hostname = {
      current: () => access,
      destination: () => destination,
      canonical: () => "example.com",
      // The helper still exposes the access identity here; the publication
      // modules must pass their destination explicitly to the model.
      options: () => ({ currentHostname: access, canonicalHostname: "example.com" }),
    };
    // Preview facts use the model's currentHostname argument directly;
    // production facts use canonical and would mask a wrong argument.
    const draft = facts({
      hasOpenPr: true,
      previewOnly: true,
      baseRef: "feature/example",
    });
    const modelNoun = destination === "example.com" ? "the preview for “feature/example”" : destination;

    for (const model of [true, false]) {
      test(`publish-button ${model ? "model" : "fallback"} confirmation names ${label}`, () => {
        const { doc } = loadBar(draft, { CMSHostname: hostname }, { model, nativePublish: true });
        doc.getElementById("cms-publish-button").click();
        expect(doc.getElementById("cms-publish-state-actions").textContent).toContain(
          `Put this on ${model ? modelNoun : destination}?`,
        );
      });

      test(`publish-step-hint ${model ? "model" : "fallback"} draft names ${label}`, () => {
        const { doc } = loadBar(draft, { CMSHostname: hostname }, {
          model,
          publish: false,
          nativePublish: true,
          deploy: true,
        });
        expect(doc.getElementById("cms-publish-state-text").textContent).toContain(
          `not on ${model ? modelNoun : destination} yet`,
        );
      });
    }

    test(`publish-button busy and rejected publish name ${label}`, async () => {
      const { doc, win } = loadBar(draft, {
        CMSHostname: hostname,
        CMS_REPO: "owner/repo",
        CMSPublishProgress: {
          get: () => ({ ready: true, facts: draft, prNumber: 7 }),
          getToken: () => "fixture",
          subscribe() {},
        },
      }, {
        fetch: async (url, init) => init && init.method === "POST"
          ? { ok: false, status: 503 }
          : { ok: true, status: 200, json: async () => ({ labels: [] }) },
      });
      const publishing = win.__publishButton.doPublish();
      expect(doc.getElementById("cms-publish-state-actions").textContent).toContain(`Sending it to ${modelNoun}…`);
      await publishing;
      expect(doc.getElementById("cms-publish-state-actions").children[0].textContent).toBe(
        `${destination} did not accept the publish just now (GitHub returned 503). ` +
          "Nothing you typed has been lost — press Publish again in a moment.",
      );
    });
  }
});

test("production model copy keeps the canonical destination (#533)", () => {
  const { doc } = loadBar(facts({ hasOpenPr: true }), {
    CMSHostname: {
      current: () => "preview-pr42.example.com",
      destination: () => "preview-pr42.example.com",
      canonical: () => "example.com",
    },
  });
  expect(doc.getElementById("cms-publish-state-text").textContent).toContain("not on example.com yet");
  doc.getElementById("cms-publish-button").click();
  expect(doc.getElementById("cms-publish-state-actions").textContent).toContain("Put this on example.com?");
});

test("publish-step-hint fallback updates after the served config settles (#533)", () => {
  let destination = "example.com";
  const { doc, tick } = loadBar(facts({ hasOpenPr: true }), {
    CMSHostname: {
      current: () => "example.com",
      destination: () => destination,
      canonical: () => "example.com",
    },
  }, {
    model: false,
    publish: false,
    nativePublish: true,
    deploy: true,
  });
  expect(doc.getElementById("cms-publish-state-text").textContent).toContain("not on example.com yet");
  destination = "preview-pr42.example.com";
  tick();
  expect(doc.getElementById("cms-publish-state-text").textContent).toContain("not on preview-pr42.example.com yet");
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
  for (const liveDerive of [false, true]) {
    test(`publish-button publication URL ${liveDerive ? "entry" : "site fallback"}: ${access} -> ${destinationOrigin}`, () => {
      const { doc } = loadBar(facts({ hasOpenPr: true }), {
        location: new URL(access + "/admin/#/collections/posts/entries/hello"),
        CMS_SITE_ORIGIN: "https://example.com",
        CMSHostname: {
          current: () => new URL(access).hostname,
          publicOrigin: () => access,
          destination: () => new URL(destinationOrigin).hostname,
          destinationOrigin: () => destinationOrigin,
          canonical: () => "example.com",
        },
      }, { liveDerive });
      doc.getElementById("cms-publish-button").click();
      expect(doc.getElementById("cms-publish-state-actions").textContent).toContain(
        "It will appear at " + destinationOrigin + (liveDerive ? "/blog/hello/" : "") + " in about 5 minutes.",
      );
    });
  }
}

test("publish-button site fallback supports a cached helper without destinationOrigin", () => {
  const { doc } = loadBar(facts({ hasOpenPr: true }), {
    CMS_SITE_ORIGIN: "http://example.net:4000",
    CMSHostname: { destination: () => "example.net", canonical: () => "example.net" },
  });
  doc.getElementById("cms-publish-button").click();
  expect(doc.getElementById("cms-publish-state-actions").textContent).toContain("It will appear at http://example.net:4000");
});

for (const [tab, siteOrigin, apex, config, status, expected] of [
  ["https://www.example.com", "https://example.com", "example.net", "", 404, "https://example.com"],
  [
    "https://preview-pr7.example.com",
    "https://example.com",
    "example.com",
    "site_url: javascript:alert(1)\n",
    200,
    "https://example.com",
  ],
  ["https://www.example.com", "", "example.net", "", 404, "https://example.net"],
  ["https://preview-pr7.example.com", "", "example.net", "site_url: javascript:alert(1)\n", 200, "https://example.net"],
]) {
  test(
    `publish-button canonical fallback (${siteOrigin || "apex " + apex}) survives unreadable config at ${tab}`,
    async () => {
      const { doc, win } = loadBar(facts({ hasOpenPr: true }), {
        location: new URL(tab + "/admin/#/collections/pages/entries/about"),
        CMS_SITE_ORIGIN: siteOrigin,
        CMS_APEX: apex,
      }, {
        siteHostname: true,
        fetch: async () => ({ ok: status >= 200 && status < 300, status, text: async () => config }),
      });
      await win.CMSHostname.binding();
      doc.getElementById("cms-publish-button").click();
      expect(doc.getElementById("cms-publish-state-actions").textContent).toContain(
        `It will appear at ${expected} in about 5 minutes.`,
      );
    },
  );
}

for (const [tab, siteOrigin, apex, siteURL, expected] of [
  [
    "https://preview-pr7.example.com",
    "https://example.com",
    "example.com",
    "https://preview-pr7.example.com/path",
    "https://preview-pr7.example.com",
  ],
  ["https://preview-pr7.example.com", "", "example.com", "http://localhost:4000/admin/", "http://localhost:4000"],
]) {
  test(
    `publish-button served origin ${siteURL} overrides canonical fallback at ${tab}`,
    async () => {
      const config = `backend:\n  name: github\n  repo: acme/example\n  branch: main\n\nsite_url: ${siteURL}\ndisplay_url: ${siteURL}\n`;
      const { doc, win } = loadBar(facts({ hasOpenPr: true }), {
        location: new URL(tab + "/admin/#/collections/pages/entries/about"),
        CMS_SITE_ORIGIN: siteOrigin,
        CMS_APEX: apex,
      }, {
        siteHostname: true,
        fetch: async () => ({ ok: true, status: 200, text: async () => config }),
      });
      await win.CMSHostname.binding();
      doc.getElementById("cms-publish-button").click();
      expect(doc.getElementById("cms-publish-state-actions").textContent).toContain(
        `It will appear at ${expected} in about 5 minutes.`,
      );
    },
  );
}

test("publish-button uses its canonical fallback before the served config settles", () => {
  const { doc } = loadBar(facts({ hasOpenPr: true }), {
    location: new URL("https://preview-pr7.example.com/admin/#/collections/pages/entries/about"),
    CMS_SITE_ORIGIN: "https://example.com",
    CMS_APEX: "example.com",
  }, { siteHostname: true, fetch: () => new Promise(() => {}) });
  doc.getElementById("cms-publish-button").click();
  expect(doc.getElementById("cms-publish-state-actions").textContent).toContain("It will appear at https://example.com");
});

// #625 item 1: on a coming-soon (gated) site the bar and the confirmation must
// not promise "it then takes about 5 minutes to appear" — visitors keep seeing
// the coming-soon page. The gate state is the one site-gate-banner.js already
// resolved: its banner is in the page exactly while the site is gated.
const GATE_SENTENCE = "visitors keep seeing the coming-soon page until the site is switched on";

test.describe("gate-aware publishing copy (#625 item 1)", () => {
  for (const model of [true, false]) {
    const kind = model ? "model" : "fallback";

    test(`${kind} draft bar says visitors keep seeing the coming-soon page when gated`, () => {
      const { doc } = loadBar(facts({ hasOpenPr: true }), {}, {
        model,
        publish: false,
        nativePublish: true,
        deploy: true,
        gated: true,
      });
      const text = doc.getElementById("cms-publish-state-text").textContent;
      expect(text).toContain(GATE_SENTENCE);
      expect(text).not.toMatch(/minutes/);
    });

    test(`${kind} draft bar keeps the live-site wording when the site is switched on`, () => {
      const { doc } = loadBar(facts({ hasOpenPr: true }), {}, {
        model,
        publish: false,
        nativePublish: true,
        deploy: true,
      });
      const text = doc.getElementById("cms-publish-state-text").textContent;
      expect(text).not.toMatch(/coming-soon/);
      expect(text).toMatch(/Click Publish to put it/);
    });

    test(`${kind} confirmation says the same when gated, and is unchanged when not`, () => {
      const gated = loadBar(facts({ hasOpenPr: true }), {}, { model, nativePublish: true, gated: true });
      gated.doc.getElementById("cms-publish-button").click();
      const note = gated.doc.getElementById("cms-publish-state-actions").textContent;
      expect(note).toContain(GATE_SENTENCE);
      expect(note).not.toMatch(/minutes/);

      const open = loadBar(facts({ hasOpenPr: true }), {}, { model, nativePublish: true });
      open.doc.getElementById("cms-publish-button").click();
      const openNote = open.doc.getElementById("cms-publish-state-actions").textContent;
      expect(openNote).not.toMatch(/coming-soon/);
      expect(openNote).toMatch(/^Put this on .*\? It .*5 minutes/);
    });
  }
});
