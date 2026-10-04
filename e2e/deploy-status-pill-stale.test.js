// @lane: local — pure-Node behavioral test for deploy-status-pill.js's stale state (vm sandbox, scripted fetch, fake clock)
/*
 * The editor-toolbar pills poll GitHub every 30 s. When polling breaks while a
 * pill is showing, the pill must not freeze on a spinner that is secretly
 * disconnected from reality: after STALE_THRESHOLD_MS (5 min) without a
 * successful poll it flips to an amber "details may be out of date" state
 * (renderStalePill), keeping its link to the last-known update. Issue #534
 * found no test exercising that path; deploy-status-pill-robustness.test.js
 * only greps for the function's existence.
 *
 * Everything here is driven through the script's real polling tick in a vm
 * sandbox: a scripted fetch (no network), a fake clock (no wall-clock time),
 * and an immediate setTimeout (no sleeps). Both pills are covered, because the
 * production pill names the canonical hostname and the preview pill names the
 * configured destination, and those must stay consistent between the fresh
 * and the stale renderings.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SCRIPT = path.join(__dirname, "..", "theme", "admin", "deploy-status-pill.js");
const API = "https://api.github.com/repos/owner/repo";
const PROD_LOG = "https://github.com/owner/repo/actions/runs/101";
const PREVIEW_LOG = "https://github.com/owner/repo/actions/runs/202";
const T0 = Date.parse("2026-10-01T12:00:00Z");
const MIN = 60 * 1000;
const AMBER_TEXT = "#9a6700";
const AMBER_BORDER = "#d4a72c";

function load({
  prodState = "in_progress",
  previewState = "in_progress",
  access = "preview-pr42.example.com",
  destination = "preview-pr42.example.com",
} = {}) {
  const pills = {};
  const toolbar = {
    firstChild: null,
    insertBefore(node) {
      pills[node.id] = node;
      this.firstChild = this.firstChild || node;
    },
    appendChild(node) {
      pills[node.id] = node;
      this.firstChild = this.firstChild || node;
    },
  };
  const state = { now: T0, online: true, signedIn: false };
  const responses = {
    [`${API}/deployments?environment=production&per_page=1`]: [{ id: 11 }],
    [`${API}/deployments/11/statuses?per_page=1`]: [{ id: 101, state: prodState, log_url: PROD_LOG }],
    [`${API}/deployments?per_page=20`]: [{ id: 22, environment: "preview-pr-42" }],
    [`${API}/deployments/22/statuses?per_page=1`]: [{ id: 202, state: previewState, log_url: PREVIEW_LOG }],
  };
  class FakeDate extends Date {
    static now() {
      return state.now;
    }
  }
  let tick = null;
  const sandbox = {
    window: {
      CMS_REPO: "owner/repo",
      CMSHostname: {
        canonical: () => "example.com",
        current: () => access,
        destination: () => destination,
      },
    },
    document: {
      readyState: "complete",
      body: {},
      querySelector: () => toolbar,
      getElementById: (id) => pills[id] || null,
      createElement: () => ({ style: {}, setAttribute() {} }),
      addEventListener() {},
    },
    // Signed out at load, so the tick start() fires synchronously does
    // nothing; each test then drives the captured interval tick itself.
    localStorage: { getItem: () => (state.signedIn ? JSON.stringify({ token: "fixture" }) : null) },
    MutationObserver: class {
      observe() {}
    },
    fetch: async (url) => {
      if (!state.online) throw new Error("network down (fixture)");
      const body = responses[String(url)];
      if (body === undefined) throw new Error(`unscripted fetch: ${url}`);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    },
    setInterval(fn) {
      tick = fn;
      return 1;
    },
    // fetchWithRetry's back-off; immediate, so no test ever sleeps.
    setTimeout(fn) {
      fn();
      return 0;
    },
    console: { info() {}, warn() {} },
    Date: FakeDate,
    JSON,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SCRIPT, "utf8"), sandbox);
  expect(typeof tick, "deploy-status-pill.js must register its polling tick with setInterval").toBe("function");
  state.signedIn = true;

  return {
    pills,
    async pollAt(minutesAfterT0, { online }) {
      state.now = T0 + minutesAfterT0 * MIN;
      state.online = online;
      await tick();
    },
  };
}

const PILLS = [
  { id: "cms-prod-status-pill", destination: "example.com", log: PROD_LOG },
  { id: "cms-preview-build-pill", destination: "preview-pr42.example.com", log: PREVIEW_LOG },
];

test.describe("deploy-status-pill.js: the stale state (renderStalePill, #534)", () => {
  for (const { id, destination, log } of PILLS) {
    test(`${id}: a failed poll inside five minutes keeps the current update showing`, async () => {
      const { pills, pollAt } = load();
      await pollAt(0, { online: true });
      const pill = pills[id];
      expect(pill.innerHTML).toContain(`Updating ${destination}…`);

      await pollAt(4, { online: false });
      expect(pill.style.display).toBe("");
      expect(pill.innerHTML).toContain(`Updating ${destination}…`);
      expect(pill.innerHTML).not.toContain("out of date");
      expect(pill.style.color).not.toBe(AMBER_TEXT);
    });

    test(`${id}: five minutes without a successful poll turns the pill amber, naming ${destination}`, async () => {
      const { pills, pollAt } = load();
      await pollAt(0, { online: true });
      const pill = pills[id];

      await pollAt(6, { online: false });
      expect(pill.style.display).toBe("");
      expect(pill.style.color).toBe(AMBER_TEXT);
      expect(pill.style.borderColor).toBe(AMBER_BORDER);
      expect(pill.innerHTML).toContain(
        `<span>Update to ${destination} (details may be out of date — last refreshed 6m ago)</span>`,
      );
      expect(pill.title).toBe(`Publishing details for ${destination} may be out of date. View the last update.`);
      // The action: the link still opens the last-known update.
      expect(pill.href).toBe(log);
      expect(`${pill.title} ${pill.innerHTML}`).not.toMatch(/\b(deploy|deployment|run|log|poll)\b/i);
    });

    test(`${id}: once polling recovers, the amber state gives way to the current update`, async () => {
      const { pills, pollAt } = load();
      await pollAt(0, { online: true });
      const pill = pills[id];
      await pollAt(6, { online: false });
      expect(pill.innerHTML).toContain("out of date");

      // The deployment status is unchanged (same status id): the pill must
      // still drop the stale warning rather than keep it until the next
      // state change.
      await pollAt(7, { online: true });
      expect(pill.innerHTML).toContain(`Updating ${destination}…`);
      expect(pill.innerHTML).not.toContain("out of date");
      expect(pill.style.color).not.toBe(AMBER_TEXT);
    });
  }

  test("a hidden pill never turns amber: there is nothing on screen to go stale", async () => {
    const { pills, pollAt } = load({ prodState: "success", previewState: "success" });
    await pollAt(0, { online: true });
    await pollAt(30, { online: false });
    for (const { id } of PILLS) {
      expect(pills[id].style.display, id).toBe("none");
      expect(pills[id].innerHTML || "", id).not.toContain("out of date");
    }
  });
});

for (const [access, destination] of [
  ["preview-pr42.example.com", "example.com"],
  ["example.com", "preview-pr42.example.com"],
  ["example.com", "example.com"],
  ["preview-pr42.example.com", "preview-pr42.example.com"],
]) {
  test(`fresh and stale preview pills name ${destination} when opened on ${access} (#533)`, async () => {
    const { pills, pollAt } = load({ access, destination });
    await pollAt(0, { online: true });
    expect(pills["cms-preview-build-pill"].innerHTML).toContain(`Updating ${destination}…`);
    expect(pills["cms-prod-status-pill"].innerHTML).toContain("Updating example.com…");
    await pollAt(6, { online: false });
    expect(pills["cms-preview-build-pill"].innerHTML).toContain(`Update to ${destination} (details may be out of date`);
    expect(pills["cms-preview-build-pill"].title).toBe(
      `Publishing details for ${destination} may be out of date. View the last update.`,
    );
    expect(pills["cms-prod-status-pill"].innerHTML).toContain("Update to example.com (details may be out of date");
  });
}
