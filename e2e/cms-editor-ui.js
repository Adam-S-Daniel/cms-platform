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
    // RE-CLICK on a silent no-op. Decap's Editor Save (actions/entries.ts
    // persistEntry) rejects SILENTLY — no toast, the form stays dirty and Save
    // stays ENABLED — when `fieldsErrors` is non-empty at click time. Field
    // widgets re-validate ASYNCHRONOUSLY right after a (re)mount, so the first
    // click can land in that transient-invalid window and no-op (#80 layer 11b;
    // host runs 28372038163 unpublish leg + 28380065742 cms-publish-loop
    // cleanup leg both stuck "UNSAVED CHANGES" + enabled Save for 60s). Once
    // re-validation settles the same click persists, so while Save is still
    // actionable and unconfirmed, click it again. A genuinely-invalid form
    // never clears its errors, so this still fails at `timeout` rather than
    // masking a real validation/persist error. Idempotent: a successful save
    // sets hasChanged=false (Decap disables Save and the onClick guard
    // `hasChanged && onPersist()` no-ops), so this never double-persists.
    if (!toast && !disabled) {
      // A missed re-click (Save settled to disabled between the read above and
      // this click, or not yet actionable) is non-fatal — the toPass predicate
      // re-evaluates either way. `.catch(() => false)` (not the banned empty
      // arrow) keeps this out of silent-catch-lint while staying a no-op.
      await save.click({ timeout: 2_000 }).catch(() => false);
    }
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
// Publish the open entry THROUGH THE UI an editor actually uses — which is
// now TWO different UIs depending on the shell, and getting that wrong is a
// live regression a green unit-lint lane cannot see.
//
// ── Why this branches (cms-platform v0.1.97) ───────────────────────────
// The PRODUCTION shell ships the publishing-UX phase 2 + 3 shims
// (docs/PUBLISHING-UX.md): `one-door-publish.js` CSS-hides Decap's Status
// dropdown, and `publish-button.js` CSS-hides Decap's split Publish control
// and renders `#cms-publish-button` in its place, with an inline "Yes,
// publish" confirmation instead of a dropdown menu item.
//
// The old body of this function did `getByRole("button", {name: /^Publish$/i})`
// then `getByRole("menuitem", {name: /publish now/i})`. On the new shell the
// FIRST of those still resolves — to the platform's own button, because
// getByRole skips the CSS-hidden Decap one — so the click "succeeds", opens
// the inline confirmation, and then the menuitem lookup finds nothing. That
// is precisely how run 33439336337 failed: the entry was created and its PR
// opened, then the publish leg died about two minutes in.
//
// So: prefer the platform button when it is on screen, and keep the Decap
// path for every shell that has no replacement — `index-test.html` (the
// rehearsal surface, which deliberately keeps Decap's own controls) and
// `index-local.html` (no editorial workflow at all).
//
// The Status→Ready step is kept in the Decap branch only. On the production
// shell it is not merely unnecessary, it is the SECOND DOOR phase 2 closed:
// setting Ready applies `decap-cms/pending_publish`, which
// `auto-merge-when-ready` fires on. Driving it there would be the test
// exercising a route the product no longer offers.
//
// ── The wait is load-bearing ───────────────────────────────────────────
// `#cms-publish-button` only renders once `publish-progress.js` has FOUND
// the entry's `cms/<collection>/<slug>` pull request, which is one poll
// after Save. Without a wait this races the poller and falls through to the
// Decap branch on the very shell where Decap's control is hidden — the
// original bug, in a new costume. PUBLISH_BUTTON_TIMEOUT_MS covers a poll
// interval plus GitHub latency with room to spare.
const PUBLISH_BUTTON_TIMEOUT_MS = 90_000;
// How long to give `arm()` a chance to land the `cms/ready` label after the
// confirmation click, before treating "not armed yet" as a hang rather than
// ordinary GitHub latency. See "loud on the two silent outcomes" below.
const PUBLISH_ARM_TIMEOUT_MS = 60_000;

// #386 — the state-bar slot's ID (`SLOT_ID` in theme/admin/publish-button.js,
// `ACTIONS_ID` in theme/admin/publish-step-hint.js — the two must already
// agree, or the button would never render into the bar at all).
const PUBLISH_SLOT_ID = "cms-publish-state-actions";

// #386 — the toolbar's two SILENT publish-failure outcomes. `doPublish()` in
// theme/admin/publish-button.js renders one of these into the state-bar slot
// and RETURNS WITHOUT THROWING on (a) a stale/missing PR number or Decap
// token, or (b) a non-2xx response arming the PR's `cms/ready` label — so a
// `publishViaUi` that only clicks the confirmation and returns cannot tell a
// real publish from either silent failure. A silent (a) on an entry UPDATE
// (the poller's last answer predated the PR) cost 34 minutes of an unrelated
// deploy-lane timeout before the real cause showed up at all (adamdaniel.ai
// run 33573287045, cms-platform#386). Kept as lowercase SUBSTRINGS of
// publish-button.js's own text, not full copies, so a cosmetic wording
// change there doesn't false-fail this file. Lint-locked by
// e2e/publish-error-strings.test.js, which asserts both remain present in
// publish-button.js's doPublish().
const PUBLISH_NOT_READY_TEXT = "could not be published right now";
const PUBLISH_REJECTED_TEXT = "did not accept the publish just now";

// Read window.CMSPublishProgress's current snapshot, or null if the module
// (or the page) isn't there. { ready, facts, prNumber, prUrl, entry } —
// see theme/admin/publish-progress.js's header for what each fact means.
function publishProgressState(page) {
  return page.evaluate(() => {
    const p = window.CMSPublishProgress;
    return p && typeof p.get === "function" ? p.get() : null;
  });
}

// Ask the poller to re-fetch NOW rather than wait out its 30s interval. A
// no-op (never throws) when the module isn't on this shell.
function refreshPublishProgress(page) {
  return page.evaluate(() => {
    const p = window.CMSPublishProgress;
    if (p && typeof p.refresh === "function") p.refresh();
  });
}

async function publishViaUi(page) {
  // Deterministic shell selection (#386) — DO NOT go back to "did
  // #cms-publish-button attach within N seconds": that races
  // publish-progress.js's poller. On an entry UPDATE the button can still be
  // absent several seconds after Save because the poller hasn't found the
  // PR yet, and the old code fell through to Decap's own control on the
  // very shell where it's hidden-but-not-removed — the original #382
  // failure, in a new costume.
  //
  // publish-button.js sets `window.__publishButtonInstalled` as the FIRST
  // thing its IIFE does — unconditional on route, poller state or the bar
  // being on screen — and the script is loaded ONLY by index.html (the
  // production shell); index-test.html and index-local.html never include
  // it. So the flag is available the instant the page has finished loading,
  // and it says which shell this is regardless of timing.
  const hasPlatformShell = await page.evaluate(() => Boolean(window.__publishButtonInstalled));

  if (hasPlatformShell) {
    const platformButton = page.locator("#cms-publish-button");

    // Wait for publish-progress.js to have FOUND this entry's open PR
    // BEFORE clicking anything (#386 hypothesis 2): clicking while the
    // poller's last answer predated the PR (`facts: null` or
    // `hasOpenPr: false`, `prNumber: null`) lets `doPublish()` hit its
    // silent `!prNumber` branch, which renders text and returns — it never
    // throws, so the click alone can never prove anything. One manual
    // refresh() shortens the wait instead of relying on the 30s interval.
    await refreshPublishProgress(page);
    await page.waitForFunction(
      () => {
        const p = window.CMSPublishProgress;
        const s = p && p.get();
        return Boolean(s && s.ready && s.facts && s.facts.hasOpenPr && s.prNumber);
      },
      undefined,
      { timeout: PUBLISH_BUTTON_TIMEOUT_MS, polling: 2_000 },
    );

    // Now the button itself: it renders disabled while there are unsaved
    // changes, and is absent entirely until render() next runs.
    await platformButton.waitFor({ state: "visible", timeout: PUBLISH_BUTTON_TIMEOUT_MS });
    await page.waitForFunction(
      () => {
        const b = document.getElementById("cms-publish-button");
        return Boolean(b) && !b.disabled;
      },
      undefined,
      { timeout: PUBLISH_BUTTON_TIMEOUT_MS },
    );
    await platformButton.click();
    // The inline confirmation, which names the URL and the ETA.
    await page.getByRole("button", { name: /^Yes, publish$/i }).click();

    // ── Loud on the two silent outcomes (#386) ────────────────────────
    // doPublish() renders a "Sending it to the website…" note into the
    // slot while its two fetches are in flight, then either clears it (on
    // success) or replaces it with one of the two error strings above.
    // Wait out the busy phase before reading what's left — bounded, and
    // deliberately NOT fatal on its own timeout: a slow render tick leaving
    // the note past 30s doesn't mean arm() failed, so fall through to the
    // error-text check either way; the armed-wait below is the real gate.
    const slot = page.locator(`#${PUBLISH_SLOT_ID}`);
    await page
      .waitForFunction(
        (id) => {
          const el = document.getElementById(id);
          return !el || !/Sending it to the website/i.test(el.textContent || "");
        },
        PUBLISH_SLOT_ID,
        { timeout: 30_000 },
      )
      .catch(() => false); // the timeout itself is not fatal here — see comment above

    const stateAfterConfirm = await publishProgressState(page);
    const prNumber = stateAfterConfirm && stateAfterConfirm.prNumber;
    const slotText = ((await slot.textContent().catch(() => "")) || "").toLowerCase();
    if (slotText.includes(PUBLISH_NOT_READY_TEXT) || slotText.includes(PUBLISH_REJECTED_TEXT)) {
      throw new Error(
        `publishViaUi: the publish toolbar reported a silent failure for PR ` +
          `#${prNumber != null ? prNumber : "?"}: "${(await slot.textContent().catch(() => "")).trim()}"`,
      );
    }

    // Not an error string on screen is not proof of success either — the
    // slot can sit briefly empty between the busy note clearing and the
    // refreshed facts landing (doPublish() calls refresh() without
    // awaiting it). The one fact both the button and the bar agree defines
    // "queued to merge itself" is entry-status-model's own `armed`, so wait
    // for THAT — with our own refresh() calls to avoid riding out the full
    // 30s poll interval — and fail loud, naming the PR, if it never comes.
    await page
      .waitForFunction(
        () => {
          const p = window.CMSPublishProgress;
          if (p && typeof p.refresh === "function") p.refresh();
          const s = p && p.get();
          return Boolean(s && s.facts && s.facts.armed === true);
        },
        undefined,
        { timeout: PUBLISH_ARM_TIMEOUT_MS, polling: 2_000 },
      )
      .catch(async () => {
        const info = await publishProgressState(page);
        throw new Error(
          `publishViaUi: PR #${prNumber != null ? prNumber : "?"} did not arm within ` +
            `${PUBLISH_ARM_TIMEOUT_MS / 1000}s of confirming publish. Last known facts: ` +
            `${JSON.stringify(info && info.facts)}`,
        );
      });
    return;
  }

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
// confirm modal. Decap 3.15.1's "Delete published entry" actually uses a
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
// for forward-compat and is harmless: under 3.15.1's native confirm the
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
  // modal, click its confirm button. No-op under 3.15.1's native confirm (the
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
// renders Decap's NotFound ("Not Found") because Decap 3.15.1 registers
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

// The collection-top "start a new entry" control, matched by accessible
// name. Single-sourced because its NAME is version-dependent and that is
// what silently broke the decap 3.14.1 bump attempt: cms-smoke's
// `getByRole("link", {name: /new tag|new entry/i})` resolved nothing and
// the click timed out 30 s, twice — misattributed at the time to "the
// adamdaniel built-site shape × 3.14.1" rather than to a renamed control.
//
// Decap's EN `collection.collectionTop.newButton` went from
// "New %{collectionLabel}" (3.12.2) to "＋ %{collectionLabel}" (3.15.x) and
// 3.15.x additionally sets `newButtonAriaLabel` — "Create entry of type
// %{collectionLabel}" — as the element's `aria-label`, which WINS over the
// text content for the accessible name. So the visible label and the
// accessible name diverge, and neither old pattern survives.
//
// The element itself is stable across both eras (a `CollectionTopNewButton`
// LINK carrying the new-entry route), so match the one token both eras
// share — the collection label — plus either verb. Flat alternation, no
// nested quantifier (ReDoS-safe, same rule as DELETE_CONFIRM_BUTTON_RE).
function collectionNewLink(page, collectionLabel) {
  return page
    .getByRole("link", { name: new RegExp(`(new|create)\\b.*\\b${collectionLabel}`, "i") })
    .first();
}

module.exports = {
  collectionNewLink,
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
