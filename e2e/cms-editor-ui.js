/*
 * Shared Decap entry-editor UI interactions.
 *
 * Why this module exists (#1723 / PR #407):
 * The Published toggle and the Save → Ready → Publish flow were copy-
 * pasted into every CMS loop spec (cms-publish-loop-prod-mutate,
 * cms-unpublish-republish, cms-media-roundtrip, and the -preview
 * variants). Copies drift: one spec's cleanup leg still looked for the
 * Published widget as `getByRole("checkbox")` while the rest had moved to
 * `getByRole("switch")` (Decap renders it as a switch). That drift sat
 * latent until #1723's future-date fix let the prod-mutate cleanup run
 * for the first time — then it failed on the stale selector. Centralising
 * these interactions here (and lint-locking that specs don't hand-roll
 * them — see cms-editor-ui.test.js) keeps every caller in sync.
 *
 * Pure helpers over the caller's Playwright `page`; `expect` comes from
 * ./base so messages match the rest of the suite.
 */
const { expect } = require("./base");

// Decap's boolean Published widget is a SWITCH (role="switch"), NOT a
// checkbox; its state is exposed via aria-checked, not :checked. The
// accessible name is the field label "Published". `.first()` guards the
// rare double-mount during editor hydration.
function publishedSwitch(page) {
  return page.getByRole("switch", { name: /^Published$/i }).first();
}

// Toggle the Published switch to `on` (true ⇒ published, false ⇒ draft),
// idempotently — read aria-checked and only click when it must change,
// then assert the resulting state. Mirrors the proven pattern every
// publish/unpublish leg used by hand.
async function setPublished(page, on, { visibleTimeout = 30_000, settleTimeout = 5_000 } = {}) {
  const toggle = publishedSwitch(page);
  await expect(toggle, "Published switch should be visible").toBeVisible({
    timeout: visibleTimeout,
  });
  const want = on ? "true" : "false";
  if ((await toggle.getAttribute("aria-checked")) !== want) {
    await toggle.click();
  }
  await expect(toggle, `Published switch should be aria-checked=${want}`).toHaveAttribute(
    "aria-checked",
    want,
    { timeout: settleTimeout },
  );
}

// Assert (without toggling) the Published switch reflects `on`.
async function expectPublished(page, on, { timeout = 5_000 } = {}) {
  await expect(
    publishedSwitch(page),
    `Published switch should reflect ${on ? "published" : "draft"} (aria-checked=${on})`,
  ).toHaveAttribute("aria-checked", on ? "true" : "false", { timeout });
}

// Click Save and wait for Decap's "Changes saved" confirmation. In
// editorial_workflow mode Save stays disabled afterwards (the toolbar
// swaps to a status control), so we gate on the text, not toBeEnabled.
async function saveEntry(page, { timeout = 60_000 } = {}) {
  const save = page.getByRole("button", { name: /^Save$/i });
  await expect(save).toBeVisible({ timeout });
  // Click Save if it engages within a short window (the normal dirty-Draft
  // path). In the editorial-workflow "Status: Ready" state a field edit
  // AUTO-PERSISTS into the open PR, so Save stays `disabled` (nothing to
  // click) and the transient "Changes saved" toast already fired — and may
  // have faded — back in the toggle step (the host-loop unpublish leg, #80
  // layers 6/7). So confirm the write via EITHER signal: the toast (normal
  // click path, caught immediately) OR the PERSISTENT saved state — Save
  // `disabled` == no unsaved changes. Every caller makes a guaranteed-real
  // field mutation before saving (setPublished asserts the opposite state
  // first, or a body/image edit), so a disabled Save here can only mean
  // "saved", never "nothing changed".
  await save.click({ timeout: 4_000 }).catch((e) => {
    // Not an error: in the editorial Ready state Save never becomes
    // actionable (the edit auto-saved). Log loudly (no silent catch) and
    // fall through to the persisted-state assertion below.
    console.warn(`[saveEntry] Save not actionable, treating as auto-saved: ${e.message}`);
  });
  await expect(async () => {
    const toast = await page
      .getByText(/Changes saved/i)
      .first()
      .isVisible()
      .catch(() => false);
    const disabled = await save.isDisabled().catch(() => false);
    expect(toast || disabled, "expected the 'Changes saved' toast or a disabled Save").toBe(true);
  }).toPass({ timeout });
}

// Publish the entry's pending changes through the editor — STATE-ROBUST
// across the two editorial-workflow shapes:
//
//   - A fresh / not-yet-published entry sits in the Draft → In review →
//     Ready column and shows a `Status: Draft|In review` chip that must
//     be advanced to "Ready" before "Publish" is enabled.
//   - A re-edited ALREADY-PUBLISHED entry (e.g. a cleanup leg unpublishing
//     after the forward leg published) has no such chip — it exposes the
//     `Publish ▾` control directly.
//
// Gate the Ready step on the Draft chip's presence — and do NOT hard-
// assert a `Status: Ready` chip afterwards. In the published-re-edit
// state, advancing to Ready surfaces the `Publish ▾` control directly
// (no `Status: Ready` chip), so the old unconditional
// `expect(Status: Ready)` timed out there (#1723). `Publish.click()`
// already auto-waits for the control to be actionable, which is the
// real gate. Callers must Save first (use saveEntry) so the toolbar has
// settled before we read the chip.
async function publishViaUi(page) {
  const draftChip = page.getByRole("button", { name: /^Status:\s*(Draft|In review)$/i }).first();
  if (await draftChip.isVisible().catch(() => false)) {
    await draftChip.click();
    await page.getByRole("menuitem", { name: /^Ready$/i }).click();
  }
  await page.getByRole("button", { name: /^Publish$/i }).click();
  await page
    .getByRole("menuitem", { name: /publish now/i })
    .first()
    .click();
}

// The editor toolbar's Delete control — STATE-ROBUST across BOTH the
// simple-mode and editorial-workflow editor shapes.
//
// Decap's EditorToolbar (decap-cms-core EditorToolbar.js,
// renderWorkflowControls) renders the delete affordance as a SINGLE
// TOP-LEVEL <button> — never a dropdown menu item — whose label depends
// on the entry's editorial state:
//
//   hasUnpublishedChanges && isModification         → "Delete unpublished changes"
//   hasUnpublishedChanges && (isNewEntry||!isMod)    → "Delete unpublished entry"
//   !hasUnpublishedChanges && !isModification        → "Delete published entry"
//   simple mode (local backend)                      → "Delete entry" / "Delete new entry"
//
// History (#1771 follow-up, iterations 1–3): the ephemeral prod canaries
// originally published via the `cms/ready` label only (iter 1/2), NOT
// Decap's "Publish Now" — the external auto-merge landed the post on main
// while Decap's editor still held it as a brand-new editorial-workflow
// draft (isNewEntry=true, hasUnpublishedChanges=true). #1801 added
// publishViaUi (Status:Ready → Publish Now) to push the editor toward the
// PUBLISHED state. But the run-26529125192 failure proved publishViaUi
// alone is NOT enough: "Publish Now" hits branch protection (checks
// pending), so admin/publish-via-auto-merge.js catches the 422, labels
// `cms/ready`, and hands Decap a SYNTHETIC `merged:true`. The PR then
// auto-merges for REAL only ~5–15 min later. In the gap, the
// `cms/posts/<slug>` editorial branch still exists, so when the delete leg
// re-navigates to the entry Decap's loadUnpublishedEntry (the
// editorial-workflow loadEntry override, withWorkflow.js) re-loads it as an
// OPEN draft (currentStatus set, hasUnpublishedChanges=true). EditorToolbar
// then wires Delete to onDeleteUnpublishedChanges (line 654), which drops
// only the draft branch — never main — so no delete-from-main PR opens and
// the URL never 404s. The iteration-3 fix (this follow-up) is
// reopenForPublishedDelete() below: the specs first wait for the create PR
// to MERGE for real, then poll-reload the editor until Decap drops the
// editorial entry and re-loads the published file ("Delete published
// entry", no Status chip), and only THEN click delete — so the click hits
// onDelete (delete from main).
//
// Match ALL five label variants anyway so the click is robust regardless of
// which editorial state Decap shows. The control is a real <button> (the styled
// `ToolbarButton` is `styled("button")` in the bundle), so getByRole
// finds it. Pin a timeout so a future UI shape change fails fast with a
// clear error instead of pegging the runner until the outer test timeout.
function editorDeleteButton(page) {
  // Written as a flat alternation (no nested `\s+` quantifiers) so it's
  // linear-time — the ambiguous-overlap form
  // `delete\s+(published\s+|…)?(entry|changes)` trips the ReDoS lint.
  // Each branch is anchored to one literal Decap label, separated by a
  // single space, so there's nothing to backtrack.
  return page
    .getByRole("button", {
      name: /delete (published entry|unpublished entry|unpublished changes|new entry|entry|changes)/i,
    })
    .first();
}

async function clickEditorDelete(page, { visibleTimeout = 15_000, clickTimeout = 30_000 } = {}) {
  const btn = editorDeleteButton(page);
  if (!(await btn.isVisible({ timeout: visibleTimeout }).catch(() => false))) {
    // Surface a clear, actionable error rather than letting a missing
    // affordance hang. Lists the labels we matched so a future Decap
    // rename is obvious from the failure message.
    throw new Error(
      "Could not find the editor's Delete button. Expected a top-level toolbar " +
        "button matching one of: 'Delete entry', 'Delete new entry', " +
        "'Delete published entry', 'Delete unpublished entry', or " +
        "'Delete unpublished changes' (Decap renderWorkflowControls / " +
        "renderSimpleControls). If Decap changed the toolbar shape, update " +
        "editorDeleteButton() in e2e/cms-editor-ui.js.",
    );
  }
  await btn.click({ timeout: clickTimeout });
}

// ReDoS-safe flat-alternation selector for a hypothetical in-app DOM
// confirm modal. Decap 3.12.2's "Delete published entry" actually uses a
// NATIVE window.confirm (decap-cms-core@3.9.0 Editor.js handleDeleteEntry:
// !window.confirm(t('editor.editor.onDeletePublishedEntry'))), so this DOM
// button never renders in prod; kept as a forward-compatible fallback for a
// future Decap that migrates delete to an in-app <Confirm> modal. Flat
// alternation (no nested quantifiers) so it passes the same ReDoS lint as
// editorDeleteButton.
const DELETE_CONFIRM_BUTTON_RE = /^(delete|confirm|yes|ok)$/i;
function deleteConfirmButton(page) {
  return page.getByRole("button", { name: DELETE_CONFIRM_BUTTON_RE }).first();
}


// Confirm + DISPATCH the editor Delete and VERIFY it actually dispatched.
//
// #1815 delete-phase (runs 26996121665 / 26994473112): the old call-site
// pattern clicked Delete, accepted the native window.confirm via a
// persistent page.on("dialog"), then did an OPTIONAL in-page confirm-button
// click whose 5s timeout was swallowed — with NO proof Decap had issued the
// delete. clickEditorDelete()'s `await btn.click()` resolves the instant the
// synchronous window.confirm returns, so the test marched on while onDelete
// silently no-op'd: no POST /git/trees, no cms/* delete PR, no direct
// commit, no deploy; the file stayed on main until the harness safety-net
// PR. The silent no-op surfaced 900s later as "URL never 404s".
//
// The fix: ARM a wait for Decap's first delete-dispatch network call —
// POST <repo>/git/trees (decap-cms-backend-github@3.5.0 API.deleteFiles:
// getDefaultBranch → updateTree(POST /git/trees, sha:null) → commit →
// patchRef) — BEFORE running the caller's click thunk, then AWAIT it as
// positive proof the delete fired. If it never fires, throw HERE (the real
// fault site) instead of failing 900s later in the URL-404 wait. A
// best-effort in-app confirm-button click (deleteConfirmButton) is folded in
// for forward-compat and is harmless: under 3.12.2's native confirm the
// button never renders and proof comes from the awaited request, not the
// button. Both prod-loop specs call this instead of a bare clickEditorDelete.
async function confirmEditorDelete(page, doClick, { dispatchTimeout = 60_000 } = {}) {
  // The CALLER must have a persistent `page.on("dialog", d => d.accept())`
  // registered before this (the documented pattern — both prod-loop specs do
  // at test start). This helper does NOT register its own: a SECOND accepter
  // makes Playwright's per-dialog fan-out double-accept and throw "Cannot
  // accept dialog which is already handled!" (regression on loop 27013147945).
  const treesRequest = page
    .waitForRequest(
      (req) => req.method() === "POST" && req.url().includes("/git/trees"),
      { timeout: dispatchTimeout },
    )
    .then(() => true)
    .catch(() => false);
  await doClick();
  // Forward-compat: if a future Decap swaps the native confirm for an in-app
  // modal, click its confirm button. No-op under 3.12.2's native confirm (the
  // button never renders); proof of the delete is the awaited request below,
  // never this click — so a miss is logged, not fatal (silent-catch-lint).
  await deleteConfirmButton(page)
    .click({ timeout: 5_000 })
    .catch((e) => {
      console.debug(`[cleanup] optional in-app delete-confirm click skipped: ${e.message}`);
    });
  if (!(await treesRequest)) {
    throw new Error(
      "Delete was clicked and confirmed, but Decap never dispatched the git-data-API delete " +
        "(no POST .../git/trees within " +
        Math.round(dispatchTimeout / 1000) +
        "s) — the delete silently no-op'd at the confirm/dispatch boundary (#1815 delete-phase, " +
        "runs 26996121665 / 26994473112). Verify the editor was in the PUBLISHED state (Delete " +
        "published entry, no Status chip) at click time and that the native confirm was accepted, " +
        "not dismissed.",
    );
  }
}

// The "Delete published entry" affordance — the ONLY delete that removes
// the file from `main`. Matches that one label exclusively (a `\b`-style
// anchor: not "Delete UNpublished entry", not "Delete published CHANGES").
// `(?<!un)` rejects "unpublished"; the literal " entry" tail rejects
// "...published changes".
function publishedDeleteButton(page) {
  return page.getByRole("button", { name: /delete (?<!un)published entry/i }).first();
}

// The editorial-workflow "Status: …" chip Decap renders ONLY while the
// entry is loaded as an unpublished editorial-workflow entry (i.e.
// `currentStatus` is set — see Editor.js mapStateToProps `currentStatus =
// unPublishedEntry && unPublishedEntry.get('status')`). Its presence is
// the ground-truth signal that the editor is in the DRAFT/"Delete
// unpublished entry" state, where a Delete click hits
// `onDeleteUnpublishedChanges` (drops the draft branch, never touches
// main — EditorToolbar.js line 654).
function editorialStatusChip(page) {
  return page.getByRole("button", { name: /^Status:\s*(Draft|In review|Ready)$/i }).first();
}

// Re-open an entry's editor for a delete-FROM-MAIN, ROBUST against the
// editorial-workflow re-load race (#1771 follow-up, the iteration-3 root
// cause). See e2e/cms-editor-ui.test.js / the spec headers for the full
// write-up. Short version:
//
// In editorial_workflow mode Decap overrides loadEntry → loadUnpublishedEntry
// (withWorkflow.js). When you navigate to `#/collections/<col>/entries/<slug>`
// and the entry's `cms/<col>/<slug>` editorial branch STILL EXISTS — which
// it does between the synthetic `merged:true` the publish-via-auto-merge
// shim hands Decap and the REAL auto-merge landing ~5–15 min later —
// `retrieveUnpublishedEntryData` returns the open editorial entry, so the
// editor renders the DRAFT toolbar ("Status: Draft" + "Delete unpublished
// entry"). A Delete click there calls `onDeleteUnpublishedChanges` and
// removes only the draft branch; the file on main is untouched, no
// delete-from-main PR opens, and the URL never 404s (the exact run
// 26529125192 failure: post served, then the delete leg timed out with NO
// delete PR ever opened).
//
// The deterministic fix is to NOT click delete until Decap has re-loaded
// the entry as a plain PUBLISHED entry (no editorial branch ⇒ no
// `currentStatus` ⇒ "Delete published entry"). We poll-reload the editor
// until the editorial Status chip is GONE and the "Delete published entry"
// button is present. The caller is responsible for having first confirmed
// the create PR actually merged (the branch is what Decap keys off, and
// auto-merge with SQUASH closes+deletes it); this loop additionally
// tolerates the lag between merge and Decap's local-state catch-up by
// hard-reloading (which re-runs loadUnpublishedEntry against fresh
// backend state).
async function reopenForPublishedDelete(
  page,
  entryUrl,
  // totalTimeoutMs bumped 13 → 25 min (#1815 / #1771 follow-up). The
  // 13-min budget timed out in real prod (run 26551283809): after the
  // create PR's SQUASH auto-merge, Decap's loadUnpublishedEntry has to
  // re-sync past the deleted editorial branch AND past any concurrent
  // editorial-workflow runs Decap kicks off during hydration. Under
  // runner contention (a concurrent loop holding the deploy queue,
  // GitHub API lag) the resync regularly exceeds 13 min. 25 min
  // comfortably covers it and still fits inside the spec's TEST_TIMEOUT_MS
  // (80 min prod / 100 min media), which in turn fits the job timeout
  // (90 / 110 min).
  //
  // `crossCheck` (optional) is called every attempt; it should return a
  // Promise<boolean> indicating whether the create PR's file is present on
  // `main` (Contents-API cross-check). When provided, the error message
  // distinguishes "Decap is slow but the merge has landed" from "the
  // merge never landed at all" so triage is unambiguous.
  {
    titleName = /^Title$/i,
    totalTimeoutMs = 25 * 60 * 1000,
    perAttemptMs = 30_000,
    crossCheck = null,
    adminUrl = null,
  } = {},
) {
  const titleLocator = page.getByRole("textbox", { name: titleName });
  // Decap's nav menu surfaces the "Posts" link only when the admin app is
  // fully past its login flow. We use it as the proof-of-login signal
  // before deep-navigating to the entry URL.
  const postsLink = page.getByRole("link", { name: /^Posts$/i }).first();
  // Decap's transient login state surfaces a "Logging in..." chip. If we
  // see it on the deep entry route, the session has lapsed (Decap is
  // re-authenticating). The bounce-through-admin-root below recovers it.
  const loggingInChip = page.getByText(/^Logging in\.\.\.$/i).first();
  const deadline = Date.now() + totalTimeoutMs;
  let attempt = 0;
  let lastState;
  let lastCrossCheck = null;
  let lastLoggingIn = false;
  for (;;) {
    attempt += 1;

    // Bounce through admin ROOT every attempt (#1815, run 26592333311).
    // Without this, a deep goto(entryUrl) on a session whose Decap login
    // state lapsed during the long create-PR-merge wait surfaces the
    // "Logging in..." spinner forever — the editor never mounts and
    // Title never appears. Navigating to `${adminUrl}` (the Decap app
    // root) re-runs the login routing and lets Decap complete its
    // localStorage-replay before we deep-link into the entry. The Posts
    // link is the canonical "Decap is logged in and the nav rendered"
    // signal.
    //
    // page.addInitScript from decap-pat.seedDecapAuth re-injects the
    // PAT-backed localStorage record on every navigation, so this also
    // re-seeds the auth without the spec having to call seedDecapAuth
    // again.
    if (adminUrl) {
      await page.goto(adminUrl, { waitUntil: "domcontentloaded" });
      // Best-effort: don't fail the attempt if Posts doesn't render fast
      // enough — the subsequent entry navigation may still recover. We
      // just need to give Decap a chance to complete login. The
      // `.catch(() => false)` (not a banned `() => {}`) flows the miss
      // into a logged conditional so the choice to proceed is explicit
      // (silent-catch-lint).
      const postsRendered = await postsLink
        .waitFor({ state: "visible", timeout: Math.min(perAttemptMs, 15_000) })
        .then(() => true)
        .catch(() => false);
      if (!postsRendered) {
        console.warn(
          `[reopenForPublishedDelete] attempt ${attempt}: Posts nav not visible within the ` +
            "bounded wait after bouncing through admin root; proceeding to the entry route anyway " +
            "(Decap may still be finishing login).",
        );
      }
    }

    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });

    // Run the optional Contents-API cross-check ONCE per attempt so the
    // error message can quote a deterministic state.
    if (crossCheck) {
      try {
        lastCrossCheck = await crossCheck();
      } catch (_) {
        lastCrossCheck = null;
      }
    }

    // Wait for the editor to mount at all (Title field present).
    // `waitFor({state:"visible",timeout})` is mandatory here — Playwright's
    // `locator.isVisible()` ignores any timeout option and returns
    // synchronously, so a same-named check would race Decap's hydration
    // and return false for the entire poll budget (#1815, run 26592333311
    // logged 170 instant attempts in 1500s).
    const titleVisible = await titleLocator
      .waitFor({ state: "visible", timeout: perAttemptMs })
      .then(() => true)
      .catch(() => false);
    if (!titleVisible) {
      lastLoggingIn = await loggingInChip.isVisible().catch(() => false);
      lastState = lastLoggingIn
        ? 'editor never mounted (Title field absent; "Logging in..." chip ' +
          "still visible — Decap is stuck re-authenticating, the bounce " +
          "through admin root did not complete the login flow this attempt)"
        : "editor never mounted (Title field absent)";
    } else {
      const draftChipVisible = await editorialStatusChip(page)
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      const publishedDeleteVisible = await publishedDeleteButton(page)
        .isVisible({ timeout: 2_000 })
        .catch(() => false);
      if (!draftChipVisible && publishedDeleteVisible) {
        // PUBLISHED state reached: Delete will hit onDelete (delete from
        // main → a cms/<col>/<slug> delete PR / direct main commit).
        return;
      }
      lastState = draftChipVisible
        ? 'editorial DRAFT state (Status chip present → "Delete unpublished entry"; a delete here ' +
          "would drop only the draft branch, not main)"
        : 'no editorial chip but "Delete published entry" not yet rendered (editor still hydrating)';
    }

    if (Date.now() >= deadline) {
      const crossCheckLine =
        lastCrossCheck === true
          ? " Contents-API cross-check on main: file IS present (the create PR's merge HAS landed — " +
            "Decap is failing to catch up to it; this is a Decap-side hydration bug, not a missing merge)."
          : lastCrossCheck === false
            ? " Contents-API cross-check on main: file is ABSENT (the create PR's merge has NOT " +
              "landed; widen waitForMerge or investigate why auto-merge stalled)."
            : "";
      const loginLine = lastLoggingIn
        ? ' Last attempt observed Decap stuck on the "Logging in..." spinner: the PAT-backed ' +
          "localStorage record is present (page.addInitScript re-injects it on every nav) but Decap's " +
          "login flow is not completing. Suspect: rate-limited GitHub validation or a stale Decap " +
          "Redux slice surviving the bounce. Consider clearing browser context (cookies + " +
          "localStorage) and re-seeding before the next reopen attempt."
        : "";
      throw new Error(
        `Editor for ${entryUrl} never reached the PUBLISHED delete state within ` +
          `${Math.round(totalTimeoutMs / 1000)}s (${attempt} attempt(s)); last seen: ${lastState}.` +
          crossCheckLine +
          loginLine +
          " Decap is still loading the entry as an open editorial-workflow draft — the create " +
          "PR's cms/* branch has not been merged+removed yet, so a Delete click would call " +
          "onDeleteUnpublishedChanges (draft branch only) instead of onDelete (delete from main). " +
          "Ensure the create PR is fully merged before re-opening for delete.",
      );
    }
    await page.waitForTimeout(8_000);
  }
}

// Decap's GLOBAL media library is a MODAL opened from the top-nav
// "Media" button — it is NOT a page route. `page.goto("…/admin/#/media")`
// renders Decap's NotFound ("Not Found") because Decap 3.12.2 registers
// no `/media` page route (#1815, runs 26597250490 / 26602619236). The
// library's header is a container whose class contains "LibraryTop"; it
// holds the Upload / Copy / Download / Delete-selected controls and sits
// above the asset grid. Single-sourced here so the open-and-wait
// sequence and the brittle `[class*="LibraryTop"]` selector can't drift
// across specs (was copy-pasted in cms-media-roundtrip.spec.js +
// admin-no-occlusion.spec.js).
const MEDIA_LIBRARY_TOP_SELECTOR = '[class*="LibraryTop"]';

// The top-nav button that opens the global media library overlay.
function mediaLibraryButton(page) {
  return page.getByRole("button", { name: "Media", exact: true }).first();
}

// The media library modal's header container (Upload / Delete-selected /
// Copy / Download live inside it). Callers scope header-control lookups
// to this so they don't match same-named controls elsewhere.
function mediaLibraryTop(page) {
  return page.locator(MEDIA_LIBRARY_TOP_SELECTOR).first();
}

// Open the global media library overlay (click "Media") and wait for its
// header to render. Returns the LibraryTop locator so callers can scope
// header-control interactions. Caller is responsible for being on a
// route where the top nav is present (e.g. after loading the admin root).
async function openMediaLibrary(page, { timeout = 30_000 } = {}) {
  await mediaLibraryButton(page).click();
  const top = mediaLibraryTop(page);
  await expect(top, "Decap media library modal should open").toBeVisible({ timeout });
  return top;
}

// Close the media library overlay. CRITICAL before any subsequent admin
// navigation: Decap's media library is a Redux-state overlay, NOT a
// route — a `page.goto(...)` does NOT dismiss it, so a later nav-link
// wait times out behind the still-open modal (#1815, run 26604334850:
// after deleting the asset the modal stayed up and the Posts-list wait
// 60s-timed-out behind it). No-op if the modal isn't open. Escape is
// Decap's modal-close affordance; a full reload is the guaranteed
// fallback (the overlay is client state, so a reload always clears it).
async function closeMediaLibrary(page, { timeout = 10_000 } = {}) {
  const top = mediaLibraryTop(page);
  if (!(await top.isVisible().catch(() => false))) return;
  await page.keyboard.press("Escape");
  const closed = await top
    .waitFor({ state: "hidden", timeout })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    // Escape didn't dismiss it (Decap shape/version change) — a full
    // reload reliably clears the client-state overlay.
    await page.reload({ waitUntil: "domcontentloaded" });
  }
}

module.exports = {
  publishedSwitch,
  setPublished,
  expectPublished,
  saveEntry,
  publishViaUi,
  editorDeleteButton,
  clickEditorDelete,
  deleteConfirmButton,
  confirmEditorDelete,
  publishedDeleteButton,
  editorialStatusChip,
  reopenForPublishedDelete,
  MEDIA_LIBRARY_TOP_SELECTOR,
  mediaLibraryButton,
  mediaLibraryTop,
  openMediaLibrary,
  closeMediaLibrary,
};
