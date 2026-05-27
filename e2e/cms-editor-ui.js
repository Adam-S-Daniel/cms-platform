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
  await page.getByRole("button", { name: /^Save$/i }).click();
  await expect(page.getByText(/Changes saved/i).first()).toBeVisible({ timeout });
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
  { titleName = /^Title$/i, totalTimeoutMs = 6 * 60 * 1000, perAttemptMs = 30_000 } = {},
) {
  const titleLocator = page.getByRole("textbox", { name: titleName });
  const deadline = Date.now() + totalTimeoutMs;
  let attempt = 0;
  // Assigned on every loop pass (the if/else below is exhaustive) before
  // the deadline check reads it, so no initializer is needed — and a dead
  // initializer trips no-useless-assignment.
  let lastState;
  for (;;) {
    attempt += 1;
    // Navigate to the entry route, then HARD RELOAD every pass. The page
    // is typically already on this entry's editor route (the create leg
    // mounted it), so a same-hash goto alone would not re-mount the
    // component; the reload re-runs componentDidMount → loadUnpublishedEntry
    // against fresh backend state. Once the (now-merged) editorial branch
    // is gone, Decap's loadUnpublishedEntry hits notUnderEditorialWorkflow
    // and falls through to loadEntry (the published file), so the DRAFT
    // toolbar disappears and "Delete published entry" renders.
    await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });

    // Wait for the editor to mount at all (Title field present).
    if (!(await titleLocator.isVisible({ timeout: perAttemptMs }).catch(() => false))) {
      lastState = "editor never mounted (Title field absent)";
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
      throw new Error(
        `Editor for ${entryUrl} never reached the PUBLISHED delete state within ` +
          `${Math.round(totalTimeoutMs / 1000)}s (${attempt} attempt(s)); last seen: ${lastState}. ` +
          "Decap is still loading the entry as an open editorial-workflow draft — the create " +
          "PR's cms/* branch has not been merged+removed yet, so a Delete click would call " +
          "onDeleteUnpublishedChanges (draft branch only) instead of onDelete (delete from main). " +
          "Ensure the create PR is fully merged before re-opening for delete.",
      );
    }
    await page.waitForTimeout(8_000);
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
  publishedDeleteButton,
  editorialStatusChip,
  reopenForPublishedDelete,
};
