// @lane: local — pure-node unit test for the shared run-cms-loop spine.
// No browser, no network. Runs in the Playwright runner alongside the
// other e2e/*.test.js lints (mirrors cms-host.test.js).
//
// The spine is closure/dep-injected precisely so the orchestration can
// be exercised with a fake page + fake collaborators: we assert the
// phase ORDER, which steps are skipped under which options, the
// argument plumbing into waitForCmsPullRequest / addLabel /
// waitForChangeReflected, and the call-time guard rails.

const { test, expect } = require("@playwright/test");
const { runCmsLoop, READY_STRATEGIES } = require("./run-cms-loop");

// A locator stub that records every method call onto `log` and is
// chainable enough for the spine's Save / ui-publish steps.
function makeLocator(log, label) {
  const loc = {
    async click() {
      log.push(`locator.click(${label})`);
    },
    first() {
      return loc;
    },
    async fill(v) {
      log.push(`locator.fill(${label}=${v})`);
    },
    async pressSequentially(v) {
      log.push(`locator.pressSequentially(${label}=${v})`);
    },
    async press(k) {
      log.push(`locator.press(${label}:${k})`);
    },
    async isVisible() {
      return true;
    },
    locator() {
      return loc;
    },
  };
  return loc;
}

function makeFakePage(log) {
  return {
    getByRole(role, opts) {
      const name = opts && opts.name ? String(opts.name) : "";
      log.push(`page.getByRole(${role}:${name})`);
      return makeLocator(log, `${role}:${name}`);
    },
    getByText(rx) {
      log.push(`page.getByText(${String(rx)})`);
      return makeLocator(log, `text:${String(rx)}`);
    },
    async goto(url) {
      log.push(`page.goto(${url})`);
    },
  };
}

// expect() stub — the spine calls `expect(locator).toBeVisible(...)`, so
// this must be a CALLABLE returning a matcher object (mirrors Playwright's
// `expect` shape), not the matcher object itself.
function fakeExpect() {
  return () => ({
    toBeVisible: async () => {},
  });
}

// step() stub that runs the body inline and records the phase label so
// we can assert ordering.
function makeStep(log) {
  return async (name, fn) => {
    log.push(`step:${name}`);
    return fn();
  };
}

function baseDeps(log, overrides = {}) {
  return {
    seedDecapAuth: async () => log.push("dep.seedDecapAuth"),
    waitForCmsPullRequest: async (args) => {
      log.push(`dep.waitForCmsPullRequest(${JSON.stringify(args)})`);
      return { number: 4242 };
    },
    addLabel: async (args) => {
      log.push(`dep.addLabel(${JSON.stringify(args)})`);
    },
    waitForChangeReflected: async (args) => {
      log.push(`dep.waitForChangeReflected(pill=${args.pillId},urlTimeoutMs=${args.urlTimeoutMs})`);
      // Exercise the urlCheck closure so a broken assertReflected
      // surfaces here rather than silently.
      await args.urlCheck();
    },
    step: makeStep(log),
    expect: fakeExpect(),
    ...overrides,
  };
}

const TARGET = {
  adminUrl: "https://preview-pr9.adamdaniel.ai/admin/",
  pillId: "cms-preview-build-pill",
};

test.describe("run-cms-loop spine", () => {
  test("exports the ready-strategy allow-list", () => {
    expect([...READY_STRATEGIES].sort()).toEqual(["label", "none", "ui-publish"]);
  });

  test("happy path (label): phases run in spine order and return the matched PR", async () => {
    const log = [];
    const page = makeFakePage(log);
    let mutated = false;
    const out = await runCmsLoop(
      page,
      {
        target: TARGET,
        prNumber: "9",
        openEntry: async (p) => p.goto("ADMIN#/collections/e2e/new"),
        mutate: async () => {
          mutated = true;
        },
        save: true,
        base: "feat/x",
        filePath: "_e2e/canary-delete-preview-1.md",
        canaryMarker: "e2e-delete-preview:1",
        ready: "label",
        beforeReflect: async (p) => p.goto("ADMIN#/collections/e2e/entries/canary-page"),
        assertReflected: async () => true,
        urlTimeoutMs: 123,
      },
      baseDeps(log),
    );

    expect(mutated).toBe(true);
    expect(out.pr).toEqual({ number: 4242 });

    // The collaborator-touching phases must appear in spine order.
    const order = log.filter(
      (l) =>
        l === "dep.seedDecapAuth" ||
        l.startsWith("dep.waitForCmsPullRequest") ||
        l.startsWith("dep.addLabel") ||
        l.startsWith("dep.waitForChangeReflected") ||
        l === "page.goto(ADMIN#/collections/e2e/new)" ||
        l === "page.goto(ADMIN#/collections/e2e/entries/canary-page)",
    );
    expect(order).toEqual([
      "dep.seedDecapAuth",
      "page.goto(ADMIN#/collections/e2e/new)",
      'dep.waitForCmsPullRequest({"base":"feat/x","filePath":"_e2e/canary-delete-preview-1.md","canaryMarker":"e2e-delete-preview:1","timeoutMs":300000})',
      'dep.addLabel({"prNumber":4242,"label":"cms/ready"})',
      "page.goto(ADMIN#/collections/e2e/entries/canary-page)",
      "dep.waitForChangeReflected(pill=cms-preview-build-pill,urlTimeoutMs=123)",
    ]);
    // Save phase fired (button click + Changes-saved expect).
    expect(log).toContain("page.getByText(/Changes saved/i)");
  });

  test("save:false skips the Save / Changes-saved phase", async () => {
    const log = [];
    const page = makeFakePage(log);
    await runCmsLoop(
      page,
      {
        target: TARGET,
        seedAuth: false,
        openEntry: async () => {},
        mutate: async () => {},
        save: false,
        ready: "none",
        assertReflected: async () => true,
      },
      baseDeps(log),
    );
    expect(log).not.toContain("page.getByText(/Changes saved/i)");
    // No PR wait (no base/filePath/canaryMarker) and ready:none → no
    // addLabel.
    expect(log.some((l) => l.startsWith("dep.waitForCmsPullRequest"))).toBe(false);
    expect(log.some((l) => l.startsWith("dep.addLabel"))).toBe(false);
    expect(log.some((l) => l.startsWith("dep.seedDecapAuth"))).toBe(false);
  });

  test("ready:ui-publish drives the Status→Ready→Publish toolbar instead of addLabel", async () => {
    const log = [];
    const page = makeFakePage(log);
    await runCmsLoop(
      page,
      {
        target: TARGET,
        seedAuth: false,
        openEntry: async () => {},
        mutate: async () => {},
        save: true,
        ready: "ui-publish",
        assertReflected: async () => true,
      },
      baseDeps(log),
    );
    expect(log.some((l) => l.startsWith("dep.addLabel"))).toBe(false);
    // Toolbar drive: Status: Draft button + Ready menuitem + Publish +
    // publish now were all located.
    const located = log.filter((l) => l.startsWith("page.getByRole("));
    expect(located.join("|")).toContain("Status:");
    expect(located.join("|")).toContain("Ready");
    expect(located.join("|")).toContain("Publish");
    expect(located.join("|").toLowerCase()).toContain("publish now");
  });

  test("onPrMatched hook receives the matched PR", async () => {
    const log = [];
    const page = makeFakePage(log);
    let seen = null;
    await runCmsLoop(
      page,
      {
        target: TARGET,
        seedAuth: false,
        openEntry: async () => {},
        mutate: async () => {},
        save: false,
        base: "main",
        filePath: "_e2e/x.md",
        canaryMarker: "m",
        ready: "none",
        onPrMatched: async (pr) => {
          seen = pr;
        },
        assertReflected: async () => true,
      },
      baseDeps(log),
    );
    expect(seen).toEqual({ number: 4242 });
  });

  test("validation: required params throw at call time", async () => {
    const log = [];
    const page = makeFakePage(log);
    const ok = {
      target: TARGET,
      openEntry: async () => {},
      mutate: async () => {},
      assertReflected: async () => true,
    };
    await expect(runCmsLoop(null, ok, baseDeps(log))).rejects.toThrow(/page is required/);
    await expect(runCmsLoop(page, { ...ok, target: undefined }, baseDeps(log))).rejects.toThrow(
      /target with a pillId/,
    );
    await expect(runCmsLoop(page, { ...ok, openEntry: undefined }, baseDeps(log))).rejects.toThrow(
      /openEntry/,
    );
    await expect(runCmsLoop(page, { ...ok, mutate: undefined }, baseDeps(log))).rejects.toThrow(
      /mutate/,
    );
    await expect(
      runCmsLoop(page, { ...ok, assertReflected: undefined }, baseDeps(log)),
    ).rejects.toThrow(/assertReflected/);
  });

  test("validation: unknown ready strategy throws", async () => {
    const log = [];
    const page = makeFakePage(log);
    await expect(
      runCmsLoop(
        page,
        {
          target: TARGET,
          openEntry: async () => {},
          mutate: async () => {},
          assertReflected: async () => true,
          ready: "publish-now",
        },
        baseDeps(log),
      ),
    ).rejects.toThrow(/ready must be one of/);
  });

  test("validation: ready:label without a PR wait throws (no PR to label)", async () => {
    const log = [];
    const page = makeFakePage(log);
    await expect(
      runCmsLoop(
        page,
        {
          target: TARGET,
          openEntry: async () => {},
          mutate: async () => {},
          assertReflected: async () => true,
          ready: "label",
          // no base/filePath/canaryMarker
        },
        baseDeps(log),
      ),
    ).rejects.toThrow(/ready:'label' requires base \+ filePath \+ canaryMarker/);
  });
});
