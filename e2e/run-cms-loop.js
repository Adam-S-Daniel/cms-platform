/*
 * Shared orchestration spine for the Decap CMS publish / delete loops.
 *
 * Every real-backend (`@lane: real`) CMS loop spec walks the same
 * skeleton: seed a PAT Decap session, open the admin + an entry,
 * perform an editor action, optionally Save and wait for "Changes
 * saved", wait for the `cms/<col>/<slug>` PR Decap opens, drive a
 * "make it land" strategy (UI Publish-Now **or** the `cms/ready`
 * label), then wait for the public URL to reflect the change while
 * watching the deploy-status pill. The bespoke prod specs
 * (`cms-publish-loop*`, `cms-delete-published`,
 * `cms-publish-loop-prod-mutate`) each hand-rolled that skeleton with
 * their own load-bearing cleanup + safety-net. This module factors out
 * ONLY the skeleton, as a thin closure-driven helper, so *new* specs
 * can opt in without re-deriving it.
 *
 * Greenfield/additive by design: per issue #1004's agreed "low blast
 * radius / behaviour-preserving" depth, the existing prod specs are
 * intentionally NOT rewritten through this helper — they keep their
 * bespoke chains. `cms-delete-published-preview.spec.js` is the first
 * (and currently only) consumer.
 *
 * The helper is closure-driven: callers inject `openEntry` and
 * `mutate` (and optionally `beforeReflect` / `onPrMatched`) so the
 * spine stays generic. Every collaborator the spine touches
 * (`seedDecapAuth`, `waitForCmsPullRequest`, `addLabel`,
 * `waitForChangeReflected`, the Playwright `expect`, the `step`
 * wrapper) is overridable via the `deps` argument so the orchestration
 * itself is unit-testable with a fake page and no browser/network —
 * see `e2e/run-cms-loop.test.js`.
 */

const { seedDecapAuth: realSeedDecapAuth } = require("./decap-pat");
const {
  waitForCmsPullRequest: realWaitForCmsPullRequest,
  addLabel: realAddLabel,
} = require("./github-actions-poll");
const { waitForChangeReflected: realWaitForChangeReflected } = require("./deploy-pill");

const READY_STRATEGIES = new Set(["ui-publish", "label", "none"]);

// Lazy so requiring this module stays pure (no Playwright runner side
// effects) — unit tests inject `step`/`expect` and never hit these.
function defaultStep(name, fn) {
  return require("./base").test.step(name, fn);
}
function defaultExpect() {
  return require("./base").expect;
}

/**
 * Drive one Decap publish/delete loop.
 *
 * @param {import('@playwright/test').Page} page
 * @param {object} opts
 * @param {object}   opts.target — a cms-host target descriptor
 *   (`prodTarget()` / `previewTarget()`); only `pillId` and (for
 *   `openEntry`/`mutate` convenience via `ctx`) `adminUrl` are read.
 * @param {(page, ctx) => Promise<void>} opts.openEntry — navigate the
 *   admin to the entry/new-entry form and resolve once the editor is
 *   interactable. `ctx` is `{ target, adminUrl, prNumber }`.
 * @param {(page, ctx) => Promise<void>} opts.mutate — perform the
 *   editor action: insert a marker, fill a new entry, or click
 *   "Delete published entry" + confirm. For the delete leg pass
 *   `save: false` (the delete click *is* the mutation).
 * @param {boolean} [opts.seedAuth=true] — seed the PAT Decap session
 *   before `openEntry`.
 * @param {boolean} [opts.save=true] — after `mutate`, click Save and
 *   wait for the "Changes saved" toast. The delete leg sets this
 *   false.
 * @param {string}  [opts.base] — PR base ref for
 *   `waitForCmsPullRequest`. When `base`+`filePath`+`canaryMarker`
 *   are all set, the spine waits for the matching `cms/*` PR;
 *   otherwise it skips the PR wait (the delete leg, where Decap
 *   commits the ref directly via the git data API, opts out).
 * @param {string}  [opts.filePath] — see `base`.
 * @param {string}  [opts.canaryMarker] — see `base`.
 * @param {number}  [opts.prTimeoutMs=300000]
 * @param {'ui-publish'|'label'|'none'} [opts.ready='none'] — how the
 *   change is made to land. `label` POSTs `cms/ready` on the matched
 *   PR (requires the PR wait). `ui-publish` drives Status:Draft →
 *   Ready → Publish → Publish Now through the toolbar. `none` skips
 *   (Decap already committed directly, e.g. the delete leg).
 * @param {(pr) => Promise<void>} [opts.onPrMatched] — hook fired with
 *   the matched PR object before the ready strategy runs (annotations,
 *   logging, …).
 * @param {(page, ctx) => Promise<void>} [opts.beforeReflect] — hook
 *   fired after the ready strategy and before the URL/pill wait.
 *   Specs use it to navigate to a stable pill-mount entry (the pill
 *   only injects into an entry editor toolbar) or to best-effort
 *   label a delete PR.
 * @param {() => Promise<boolean>} opts.assertReflected — the
 *   `urlCheck` polled by `waitForChangeReflected` (URL 200 + marker
 *   for publish; URL 4xx for delete).
 * @param {number}  [opts.urlTimeoutMs=600000]
 * @param {number}  [opts.pillTerminalTimeoutMs]
 * @param {string}  [opts.prNumber] — informational parent-PR number
 *   (preview specs); surfaced in step labels + `ctx`.
 * @param {(ctx: {pr: object|null}) => Function} [opts.makeOnBudgetExhausted]
 *   — factory invoked with the spine-matched `{ pr }` to build the
 *   `onBudgetExhausted` recoverer forwarded to `waitForChangeReflected`
 *   (FIX 1 / #82). Omitted ⇒ no recoverer (current behaviour preserved).
 * @param {object}  [deps] — collaborator overrides for unit testing.
 * @returns {Promise<{ pr: object|null }>} the matched PR (or null
 *   when the PR wait was skipped).
 */
async function runCmsLoop(
  page,
  {
    target,
    openEntry,
    mutate,
    seedAuth = true,
    save = true,
    base,
    filePath,
    canaryMarker,
    prTimeoutMs = 5 * 60 * 1000,
    ready = "none",
    onPrMatched,
    beforeReflect,
    assertReflected,
    urlTimeoutMs = 10 * 60 * 1000,
    pillTerminalTimeoutMs,
    prNumber,
    makeOnBudgetExhausted,
  } = {},
  deps = {},
) {
  const {
    seedDecapAuth = realSeedDecapAuth,
    waitForCmsPullRequest = realWaitForCmsPullRequest,
    addLabel = realAddLabel,
    waitForChangeReflected = realWaitForChangeReflected,
    step = defaultStep,
    expect = defaultExpect(),
  } = deps;

  if (!page) throw new Error("runCmsLoop: page is required.");
  if (!target || !target.pillId) {
    throw new Error("runCmsLoop: target with a pillId is required.");
  }
  if (typeof openEntry !== "function") {
    throw new Error("runCmsLoop: openEntry(page, ctx) closure is required.");
  }
  if (typeof mutate !== "function") {
    throw new Error("runCmsLoop: mutate(page, ctx) closure is required.");
  }
  if (typeof assertReflected !== "function") {
    throw new Error("runCmsLoop: assertReflected() urlCheck closure is required.");
  }
  if (!READY_STRATEGIES.has(ready)) {
    throw new Error(
      `runCmsLoop: ready must be one of ${[...READY_STRATEGIES].join(
        " | ",
      )} (got ${JSON.stringify(ready)}).`,
    );
  }
  const wantPrWait = Boolean(base && filePath && canaryMarker);
  if (ready === "label" && !wantPrWait) {
    // `label` POSTs cms/ready on the *matched* PR; without the PR
    // wait there is no PR to label. Fail loudly at call time rather
    // than NPEing on `pr.number` mid-run.
    throw new Error(
      "runCmsLoop: ready:'label' requires base + filePath + canaryMarker " +
        "so the cms/* PR can be matched and labelled.",
    );
  }

  const ctx = {
    target,
    adminUrl: target.adminUrl,
    prNumber: prNumber || target.prNumber || "",
  };
  const tag = prNumber ? ` (PR #${prNumber})` : "";

  if (seedAuth) {
    await step(`runCmsLoop: seed Decap auth${tag}`, async () => {
      await seedDecapAuth(page);
    });
  }

  await step(`runCmsLoop: open admin + entry${tag}`, async () => {
    await openEntry(page, ctx);
  });

  await step(`runCmsLoop: mutate${tag}`, async () => {
    await mutate(page, ctx);
  });

  if (save) {
    await step(`runCmsLoop: Save → "Changes saved"${tag}`, async () => {
      await page.getByRole("button", { name: /^Save$/i }).click();
      // editorial_workflow Save stays disabled afterward (the toolbar
      // swaps in Status pills + Publish); the "Changes saved" toast is
      // the canonical "the cms PR was opened" signal. Mirrors
      // cms-publish-loop*.spec.js step 3.
      await expect(page.getByText(/Changes saved/i).first()).toBeVisible({
        timeout: 60_000,
      });
    });
  }

  let pr = null;
  if (wantPrWait) {
    await step(`runCmsLoop: wait for Decap cms/* PR${tag}`, async () => {
      pr = await waitForCmsPullRequest({
        base,
        filePath,
        canaryMarker,
        timeoutMs: prTimeoutMs,
      });
    });
  }

  if (typeof onPrMatched === "function") {
    await step(`runCmsLoop: onPrMatched${tag}`, async () => {
      await onPrMatched(pr);
    });
  }

  if (ready === "label") {
    await step(`runCmsLoop: label cms/ready${tag}`, async () => {
      await addLabel({ prNumber: pr.number, label: "cms/ready" });
    });
  } else if (ready === "ui-publish") {
    await step(`runCmsLoop: Status:Ready → Publish Now${tag}`, async () => {
      // Mirrors the prod publish-loop / delete-published seed leg
      // exactly so behaviour is preserved for opt-in callers.
      await page.getByRole("button", { name: /^Status:\s*Draft$/i }).click({ timeout: 30_000 });
      await page.getByRole("menuitem", { name: /^Ready$/i }).click({ timeout: 30_000 });
      await expect(page.getByRole("button", { name: /^Status:\s*Ready$/i })).toBeVisible({
        timeout: 30_000,
      });
      await page.getByRole("button", { name: /^Publish$/i }).click({ timeout: 30_000 });
      await page
        .getByRole("menuitem", { name: /publish now/i })
        .first()
        .click({ timeout: 30_000 });
    });
  }

  if (typeof beforeReflect === "function") {
    await step(`runCmsLoop: beforeReflect${tag}`, async () => {
      await beforeReflect(page, ctx);
    });
  }

  await step(`runCmsLoop: wait for change reflected (pill + URL)${tag}`, async () => {
    // FIX 1 (#82): opt-in callers supply a per-leg onBudgetExhausted
    // recoverer built from the spine-matched canary PR (e.g.
    // makePreviewCanaryRecoverer). `pr` is the matched PR (or null when the
    // PR wait was skipped); the factory decides what to do with it.
    const onBudgetExhausted =
      typeof makeOnBudgetExhausted === "function" ? makeOnBudgetExhausted({ pr }) : undefined;
    await waitForChangeReflected({
      page,
      pillId: target.pillId,
      urlCheck: assertReflected,
      urlTimeoutMs,
      ...(pillTerminalTimeoutMs ? { pillTerminalTimeoutMs } : {}),
      ...(onBudgetExhausted ? { onBudgetExhausted } : {}),
    });
  });

  return { pr };
}

module.exports = {
  runCmsLoop,
  READY_STRATEGIES,
};
