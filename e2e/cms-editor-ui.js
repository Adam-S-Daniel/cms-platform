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
// History (#1771 follow-up): the ephemeral prod canaries originally
// published via the `cms/ready` label only, NOT Decap's "Publish Now" — so
// the external auto-merge landed the post on main while Decap's editor
// still held it as a brand-new editorial-workflow draft (isNewEntry=true,
// hasUnpublishedChanges=true). That state surfaces "Delete unpublished
// entry", which the earlier `/delete (published )?entry/i` locator never
// matched — the click timed out at 30s and the run failed; and even after
// the locator was widened, that label deletes only the draft branch (never
// the file on main), so the URL never 404'd. The fix (this follow-up) is
// that BOTH ephemeral specs now publish via Status:Ready → Publish Now
// (publishViaUi), exactly like the proven cms-delete-published.spec.js, so
// Decap reaches the PUBLISHED state and the delete leg hits "Delete
// published entry" → a delete-from-main PR.
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

module.exports = {
  publishedSwitch,
  setPublished,
  expectPublished,
  saveEntry,
  publishViaUi,
  editorDeleteButton,
  clickEditorDelete,
};
