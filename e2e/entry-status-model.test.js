// @lane: local — pure-Node sandbox unit tests for the shared publish-status model
/*
 * Unit tests for theme/admin/entry-status-model.js — the single derivation of
 * "is this on the website?" that BOTH the editor bar (publish-step-hint.js)
 * and the collection list (posts-list-enhance.js) render.
 *
 * WHY THIS FILE MATTERS MORE THAN A STRUCTURAL LINT
 * The rest of the publishing-UX work is DOM and network, which only a live
 * Decap instance can really exercise. This module is the one piece that is
 * pure — no DOM, no fetch, and `now` is a parameter rather than a clock — so
 * every branch of the model is reachable here, deterministically, with no
 * browser and no wall-clock dependency (the house rule: tests must be
 * deterministic — no sleeps, no network, no reliance on wall-clock time).
 *
 * That purity was a design constraint, not a happy accident: the alternative
 * shape, where each surface derives its own words from whatever facts it
 * happens to hold, is exactly how one product ended up with three
 * vocabularies for three states (docs/PUBLISHING-UX.md §2.9), and it is not
 * testable at all without a browser.
 *
 * Loaded in a vm sandbox — the same pure-Node pattern
 * oauth-app-restriction-detector.test.js uses. The module's only side effect
 * at load is the `window.CMSEntryStatus = api` assignment.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SRC_PATH = path.resolve(__dirname, "../theme/admin/entry-status-model.js");

function loadModel() {
  const src = fs.readFileSync(SRC_PATH, "utf8");
  const sandbox = { window: {}, Date, isFinite, Math, JSON };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const api = sandbox.window.CMSEntryStatus;
  expect(
    api && typeof api,
    "theme/admin/entry-status-model.js must expose window.CMSEntryStatus",
  ).toBe("object");
  return api;
}

// A fixed instant, so nothing here depends on when the suite runs.
const NOW = Date.parse("2026-08-31T12:00:00Z");
const MIN = 60 * 1000;

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

test.describe("entry-status-model — the four badges", () => {
  test("no open PR and nothing in flight is Live", () => {
    const m = loadModel();
    const got = m.derive(facts(), { now: NOW });
    expect(got.badge).toBe(m.BADGE.LIVE);
    expect(got.modifiers).toEqual([]);
  });

  test("an open PR that is not armed is a Draft, and says only you can see it", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true }), { now: NOW });
    expect(got.badge).toBe(m.BADGE.DRAFT);
    expect(got.label).toMatch(/only you can see this/i);
  });

  test("an armed PR is Going live, and names what it is waiting on", () => {
    const m = loadModel();
    const got = m.derive(
      facts({ hasOpenPr: true, armed: true, waitingOn: "3 automatic safety checks to finish" }),
      { now: NOW },
    );
    expect(got.badge).toBe(m.BADGE.GOING_LIVE);
    expect(got.waitingOn).toBe("3 automatic safety checks to finish");
    expect(got.detail).toContain("3 automatic safety checks to finish");
  });

  test("a merged PR mid-deploy is Going live and waits on the website, not on checks", () => {
    const m = loadModel();
    const got = m.derive(facts({ merged: true, deployState: "in_progress" }), { now: NOW });
    expect(got.badge).toBe(m.BADGE.GOING_LIVE);
    expect(got.waitingOn).toMatch(/website/i);
  });

  // Each of the four stopping conditions independently, because each one
  // presents to an editor as the same thing — "I pressed Publish and nothing
  // happened" — and each needs its own sentence naming a different remedy.
  for (const [key, pattern] of [
    ["checksFailed", /safety check/i],
    ["mergeConflict", /two places at once/i],
    ["awaitingReviewGate", /approve the visual review/i],
  ]) {
    test(`${key} is Needs attention, with copy naming what to do`, () => {
      const m = loadModel();
      const got = m.derive(facts({ hasOpenPr: true, armed: true, [key]: true }), { now: NOW });
      expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
      expect(got.detail).toMatch(pattern);
    });
  }

  test("a failed deploy is Needs attention too", () => {
    const m = loadModel();
    const got = m.derive(facts({ deployState: "failure" }), { now: NOW });
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
  });

  // THE PRECEDENCE THAT MATTERS. A PR whose checks failed is still `armed`
  // — the label is still on it — so an in-flight-first ordering would spin
  // "Going live…" forever over a publish that stopped ten minutes ago. That
  // is the §2.4 defect (a progress claim that outlives the operation) with
  // the sign flipped, and it is the single most likely way this model gets
  // "simplified" into lying.
  test("stopped outranks in-flight: an armed PR whose checks failed is Needs attention", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true, checksFailed: true }), {
      now: NOW,
    });
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
    expect(got.minutesLeft).toBeNull();
  });

  test("the needs-attention copy names the site's contact when one is configured", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, checksFailed: true }), {
      now: NOW,
      contact: "Adam",
    });
    expect(got.detail).toContain("Adam");
    const generic = m.derive(facts({ hasOpenPr: true, checksFailed: true }), { now: NOW });
    expect(generic.detail).toMatch(/whoever looks after this website/i);
  });
});

test.describe("entry-status-model — the ETA", () => {
  test("counts down from the nominal check duration once a start time is known", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true, startedAt: NOW - 4 * MIN }), {
      now: NOW,
    });
    expect(got.minutesLeft).toBe(m.CHECKS_NOMINAL_MIN - 4);
    expect(got.label).toContain(String(m.CHECKS_NOMINAL_MIN - 4));
  });

  test("uses the shorter deploy nominal once the PR has merged", () => {
    const m = loadModel();
    const got = m.derive(facts({ merged: true, startedAt: NOW }), { now: NOW });
    expect(got.minutesLeft).toBe(m.DEPLOY_NOMINAL_MIN);
  });

  // An ETA that reaches zero and keeps counting reads as broken, and a
  // NEGATIVE one reads as nonsense. It floors at 1 and keeps saying "about".
  test("floors at one minute rather than going to zero or negative", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true, startedAt: NOW - 90 * MIN }), {
      now: NOW,
    });
    expect(got.minutesLeft).toBe(1);
  });

  // The honest degradation. With no start time there is no number to give,
  // and inventing one would be the §2.4 defect in a new costume.
  test("with no start time it gives the range, not a made-up number", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true }), { now: NOW });
    expect(got.minutesLeft).toBeNull();
    expect(got.label).toContain("5–15");
  });
});

test.describe("entry-status-model — the two modifiers", () => {
  // The §2.6 trap: "Published" the toggle and "Publish" the button are
  // different things. An entry can be Live AND Hidden at the same time, so
  // the modifier must never be folded into the badge.
  test("published:false is a Hidden modifier ALONGSIDE a Live badge, not instead of it", () => {
    const m = loadModel();
    const got = m.derive(facts({ published: false }), { now: NOW });
    expect(got.badge).toBe(m.BADGE.LIVE);
    expect(got.modifiers.map((x) => x.key)).toEqual(["hidden"]);
    expect(got.modifiers[0].label).toBe(m.MODIFIER_LABELS.hidden);
  });

  test("a collection with no published field acquires no modifier", () => {
    const m = loadModel();
    // undefined, NOT false — jodidaniel.com's nine section collections and
    // every file collection have no such field, and must not be reported as
    // hidden by something they cannot control.
    expect(m.derive(facts(), { now: NOW }).modifiers).toEqual([]);
    expect(m.derive(facts({ published: true }), { now: NOW }).modifiers).toEqual([]);
  });

  test("a FUTURE publish_date is a Scheduled modifier naming the date", () => {
    const m = loadModel();
    const got = m.derive(facts({ publishDate: "2026-12-25" }), { now: NOW });
    expect(got.modifiers.map((x) => x.key)).toEqual(["scheduled"]);
    expect(got.modifiers[0].label).toContain(m.MODIFIER_LABELS.scheduled);
  });

  test("a PAST publish_date is not a modifier at all", () => {
    const m = loadModel();
    expect(m.derive(facts({ publishDate: "2020-01-01" }), { now: NOW }).modifiers).toEqual([]);
  });

  // An unparseable date must be treated as UNSET. `Date.parse` on junk
  // returns NaN, and a naive `new Date(x) > now` comparison silently reads
  // NaN as "not in the future" — same answer here by luck, but the empty
  // string is the shape that actually occurs (Decap writes "" for an unset
  // date field) and a coercion bug would turn it into epoch 0.
  test("an empty or unparseable publish_date is treated as unset", () => {
    const m = loadModel();
    for (const value of ["", "   ", "not-a-date", null, undefined]) {
      expect(
        m.derive(facts({ publishDate: value }), { now: NOW }).modifiers,
        `publishDate ${JSON.stringify(value)} must produce no modifier`,
      ).toEqual([]);
      expect(m.parseDate(value)).toBeNull();
    }
  });

  test("both modifiers can apply at once", () => {
    const m = loadModel();
    const got = m.derive(facts({ published: false, publishDate: "2026-12-25" }), { now: NOW });
    expect(got.modifiers.map((x) => x.key)).toEqual(["hidden", "scheduled"]);
  });
});

test.describe("entry-status-model — one vocabulary", () => {
  // The whole point of the module. If the chip form and the sentence form
  // ever cover different sets of states, the list and the editor start
  // disagreeing again.
  test("every badge has both a sentence label and a short chip label and a colour", () => {
    const m = loadModel();
    const badges = Object.keys(m.BADGE).map((k) => m.BADGE[k]);
    expect(badges.length).toBe(4);
    for (const b of badges) {
      expect(m.SHORT_LABELS[b], `SHORT_LABELS is missing ${b}`).toBeTruthy();
      expect(m.BADGE_COLORS[b], `BADGE_COLORS is missing ${b}`).toBeTruthy();
    }
    expect(Object.keys(m.SHORT_LABELS).sort()).toEqual(badges.slice().sort());
    expect(Object.keys(m.BADGE_COLORS).sort()).toEqual(badges.slice().sort());
  });

  test("derive always returns one of the four badges and never invents a fifth", () => {
    const m = loadModel();
    const badges = Object.keys(m.BADGE).map((k) => m.BADGE[k]);
    const combos = [
      {},
      { hasOpenPr: true },
      { hasOpenPr: true, armed: true },
      { hasOpenPr: true, armed: true, checksFailed: true },
      { merged: true },
      { deployState: "in_progress" },
      { deployState: "failure" },
      { mergeConflict: true },
      { awaitingReviewGate: true },
    ];
    for (const c of combos) {
      expect(badges).toContain(m.derive(facts(c), { now: NOW }).badge);
    }
  });
});

/*
 * #371 — the two additions, and the two lies each of them avoids.
 *
 * These are the branches that decide whether an editor who pressed Publish on
 * a PR-preview environment is told the truth. Measured instance:
 * jodidaniel.com#233 — armed, every check green a minute later, still open and
 * unmerged twenty minutes on. The old model rendered that as "Going live…
 * (about 1 minute left)" for as long as the tab stayed open.
 */
const GRACE = 3 * MIN; // entry-status-model.js's STALL_GRACE_MIN

test.describe("entry-status-model — the stall (#371)", () => {
  const armedAndSettled = (sinceMsAgo) =>
    facts({
      hasOpenPr: true,
      armed: true,
      settledSince: NOW - sinceMsAgo,
    });

  test("the module's own grace constant is the one these tests use", () => {
    const m = loadModel();
    expect(m.STALL_GRACE_MIN * MIN).toBe(GRACE);
  });

  test("armed with nothing left to wait for, past the grace, is Needs attention", () => {
    const m = loadModel();
    const got = m.derive(armedAndSettled(GRACE + MIN), { now: NOW });
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
    expect(got.minutesLeft).toBe(null);
  });

  // The mirror-image lie. Native auto-merge fires a moment AFTER the last check
  // completes, so a publish that is about to land must not be reported stopped.
  test("inside the grace it is still Going live", () => {
    const m = loadModel();
    const got = m.derive(armedAndSettled(GRACE - MIN), { now: NOW });
    expect(got.badge).toBe(m.BADGE.GOING_LIVE);
  });

  test("exactly at the grace boundary it is a stall", () => {
    const m = loadModel();
    expect(m.derive(armedAndSettled(GRACE), { now: NOW }).badge).toBe(
      m.BADGE.NEEDS_ATTENTION,
    );
  });

  // An unknown must never manufacture a failure report: no settledSince means
  // the poller has not seen the condition hold, not that it has.
  test("no settledSince is never a stall", () => {
    const m = loadModel();
    const got = m.derive(facts({ hasOpenPr: true, armed: true }), { now: NOW });
    expect(got.badge).toBe(m.BADGE.GOING_LIVE);
    expect(m.isStalled(facts({ settledSince: null }), NOW)).toBe(false);
  });

  test("an unknown `now` is never a stall either", () => {
    const m = loadModel();
    expect(m.isStalled(facts({ settledSince: NOW - GRACE - MIN }), null)).toBe(false);
    expect(m.derive(armedAndSettled(GRACE + MIN), {}).badge).toBe(m.BADGE.GOING_LIVE);
  });

  // A named cause outranks the generic stall copy: the poller only ever sets
  // settledSince when no specific cause holds, but the model must not depend on
  // that to say the right thing.
  test("a named failure keeps its own copy even alongside a stall", () => {
    const m = loadModel();
    const got = m.derive(
      facts({ hasOpenPr: true, armed: true, checksFailed: true, settledSince: NOW - GRACE - MIN }),
      { now: NOW },
    );
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
    expect(got.detail).toMatch(/automatic safety checks did not pass/);
  });

  test("a stall on the live site names the site, not a branch", () => {
    const m = loadModel();
    const got = m.derive(armedAndSettled(GRACE + MIN), { now: NOW, contact: "Adam" });
    expect(got.detail).toMatch(/the website did not take the update/);
    expect(got.detail).toMatch(/Adam/);
    expect(got.detail).not.toMatch(/preview/i);
  });

  test("a stall on a preview says plainly that it will not reach the live website", () => {
    const m = loadModel();
    const got = m.derive(
      facts({
        hasOpenPr: true,
        armed: true,
        previewOnly: true,
        baseRef: "claude/issue-26-site-live-on",
        settledSince: NOW - GRACE - MIN,
      }),
      { now: NOW, contact: "Adam" },
    );
    expect(got.badge).toBe(m.BADGE.NEEDS_ATTENTION);
    expect(got.detail).toMatch(/claude\/issue-26-site-live-on/);
    expect(got.detail).toMatch(/does not reach the live website/);
    expect(got.detail).toMatch(/nothing you typed has been lost/i);
    expect(got.waitingOn).toMatch(/live website/);
  });
});

test.describe("entry-status-model — the destination (#371)", () => {
  test("with no preview fact the words are unchanged", () => {
    const m = loadModel();
    expect(m.destination(facts())).toEqual({ noun: "the website", preview: false });
    expect(m.derive(facts(), { now: NOW }).detail).toBe("This is on the website now.");
    expect(m.derive(facts({ hasOpenPr: true }), { now: NOW }).detail).toMatch(
      /not on the website yet/,
    );
  });

  test("a preview names its own branch and never promises the live site", () => {
    const m = loadModel();
    const dest = m.destination(facts({ previewOnly: true, baseRef: "claude/x" }));
    expect(dest.preview).toBe(true);
    expect(dest.noun).toMatch(/claude\/x/);

    const going = m.derive(
      facts({ hasOpenPr: true, armed: true, previewOnly: true, baseRef: "claude/x" }),
      { now: NOW },
    );
    expect(going.badge).toBe(m.BADGE.GOING_LIVE);
    expect(going.detail).toMatch(/claude\/x/);
    expect(going.detail).toMatch(/not going to the live website/);

    const draft = m.derive(
      facts({ hasOpenPr: true, previewOnly: true, baseRef: "claude/x" }),
      { now: NOW },
    );
    expect(draft.badge).toBe(m.BADGE.DRAFT);
    expect(draft.detail).toMatch(/will not go to the live website/);
  });

  // A preview whose base ref we somehow do not know must still not claim the
  // live site — the honest degradation is a vaguer noun, never a wrong one.
  test("a preview with no known branch degrades to a vague noun, not a wrong one", () => {
    const m = loadModel();
    const dest = m.destination(facts({ previewOnly: true, baseRef: null }));
    expect(dest.preview).toBe(true);
    expect(dest.noun).toBe("the preview for this branch");
  });
});
