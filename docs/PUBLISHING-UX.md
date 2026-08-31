# Publishing UX — the status model, and how to streamline it

**Audience for the SITE, which is the whole point of this document:** two
non-technical people who own the content and never open GitHub. On
jodidaniel.com that is literally the case — the owner and one helper. Nobody
in that pair can read a workflow run, approve an environment gate, or reason
about a pull request, and nothing in the design should ever require them to.

**Audience for THIS document:** whoever next changes `theme/admin/`, the
editorial-workflow reusable, or a consumer's required checks.

Everything asserted here as a measurement was measured, on Decap **3.15.1**
(the version `theme/admin/index*.html` pins), against a live instance driven
by Playwright, or read out of the shipped bundle's own source map. The
"Reproducing the measurements" section at the end is the recipe. Claims read
out of code rather than exercised against production are marked as such.

---

## 1. What an editor meets today

There is no single answer to "is this on the website?". There are **nine**
overlapping notions of published, spread across four systems, and an editor
meets at least five of them in a normal afternoon.

| # | The thing | Where it lives | What it actually controls | Can the editor see it? |
|---|---|---|---|---|
| 1 | Workflow **status** — Draft / In review / Ready | Decap toolbar dropdown; stored as a `decap-cms/<status>` PR label | On this platform, **Ready publishes the entry** (see §2.1) | Yes — as a dropdown that looks like metadata |
| 2 | **Publish → Publish now** | Decap toolbar split button | Merges the entry's PR → deploy → live | Yes, once the entry is saved clean |
| 3 | The **Workflow board** (`#/workflow`) | Decap nav | The same three statuses again, as a kanban, with a *different publish rule* (§2.1) | Yes, and it contradicts the editor |
| 4 | `published:` front matter | The entry's own fields (adamdaniel.ai posts/pages) | Whether Jekyll renders the page at all | Yes — as a toggle labelled "Published", next to a button labelled "Publish" |
| 5 | `publish_date` | The entry's own fields | A future date `publish-scheduled-posts.yml` flips `published` on | Yes |
| 6 | Site-level gate — `site_live` (jodidaniel.com) | `_data/settings.yml`, one collection | Hides **every** bio section on the live site | Only if she opens that one collection |
| 7 | Six **required status checks** | The consumer's branch ruleset | Whether the merge is allowed to happen at all | **No** |
| 8 | The manual **`regression-review`** environment gate | GitHub Environments | Parks the publish indefinitely, awaiting a human with repo access | **No** |
| 9 | **deploy-production** | GitHub Actions | The last 1–2 minutes, after the merge | Partly — the deploy-status pill, which only starts *after* the merge |

Rows 1–6 are things an editor is asked to operate. Rows 7–9 are things that
silently decide whether operating rows 1–6 had any effect.

### The chain a single click sets off

```
Save          → commit on cms/<collection>/<slug>, PR opened, label decap-cms/draft
Publish now   → PUT /pulls/N/merge  → 422 (branch ruleset)
                → publish-via-auto-merge.js adds label cms/ready
                → cms-editorial-workflow.yml: auto-merge-when-ready arms auto-merge
                → 6 required checks run                    ~5–15 min, NO signal in /admin
                   └ visual-regression may park on a human gate   ← can stop here forever
                → merge to main
                → deploy-production                        ~1–2 min, deploy pill shows this part
                → live
```

---

## 2. Findings

Each of these was reproduced deliberately. Where a finding is a reading of
code rather than an observation of production, it says so.

### 2.1 The same action has opposite rules on two surfaces — and the user is right on one of them

The reported complaint was that the admin "fails to instruct the user to first
change the status in order to be able to successfully publish." That rule is
**real**, and it belongs to the surface the editor was not on:

- **Workflow board** — `WorkflowList.requestPublish` hard-gates it:
  `if (ownStatus !== status.last()) { alert('Only items with a "Ready" status
  can be published. Please drag the card to the "Ready" column to enable
  publishing.'); return; }` — then a second `confirm()` before it proceeds.
- **Entry editor** — `EditorToolbar.renderNewEntryWorkflowPublishControls`
  renders the Publish dropdown with **no status gate and no confirmation**.
  `publishUnpublishedEntry` merges the PR whatever the status says.

Same entry, same verb, two surfaces, opposite rules, and the three words
("Draft", "In review", "Ready") are identical on both. Nobody could be
expected to hold that distinction, and no copy in the product explains it.

Worse, Decap *has* an explanation string for the status model —
`statusInfoTooltipDraft`: "Entry status is set to draft. To finalize and
submit it for review, set the status to 'In review'" — and
`renderWorkflowStatusControls` renders it only under
`useOpenAuthoring`. This platform does not use open authoring, so the one
piece of built-in guidance is unreachable here.

### 2.2 "Status: Ready" is an undisclosed publish button

Reading the code path end to end: Decap's `setPullRequestStatus` replaces the
PR's CMS label with `statusToLabel(newStatus)` = `decap-cms/pending_publish`;
`cms-editorial-workflow.yml`'s `auto-merge-when-ready` job fires on exactly
that label name and enables auto-merge; the PR then merges itself when the
required checks pass, and deploys.

So on this platform there are **two doors to production** and only one is
labelled. The unlabelled one is a dropdown an editor would reasonably treat
as a private note-to-self about where something is in her process.

(Read from the pinned bundle and the reusable's `if:` condition. Not
separately exercised against a consumer's production repo.)

### 2.3 The notice pointed at the Publish button covered the Publish button

`publish-step-hint.js` shipped as a `position: fixed`, top-centre,
`pointer-events: none` banner reading *"Not published yet — click Publish,
then choose 'Publish now'."* Measured against a live 3.15.1 admin, the
banner's own rectangle over each control:

| viewport | Save | Status | Publish | Delete |
|---|---|---|---|---|
| 3000×1500 | 0 | 0 | 0 | 0 |
| 2000×1100 | 0 | 0 | 0 | 2463 px² |
| 1440×900 | 0 | 568 px² | **2682 px² (68%)** | 5071 px² |
| 1280×800 | 0 | **2520 px² (47%)** | **2682 px² (68%)** | 5071 px² |
| 1024×768 | 926 px² | 3394 px² | 2438 px² | 3536 px² |
| 393×852 | 0 | 0 | 0 | 0 |

Fixed in the same change as this document. Two things about *why nothing
caught it* generalise beyond this one banner, and both are now guarded:

- **`pointer-events: none` defeats a hit-test occlusion guard.**
  `e2e/ui-visibility.js`'s `expectReachable` asks `document.elementFromPoint`
  at the control's centre — the right question for "can they click it", and
  the wrong one for "can they read it". The control stayed clickable and the
  guard stayed green for the entire time the banner was on production.
  `expectNoInjectedOverlap` now asks the geometric question instead.
- **The `@admin-read` viewport matrix brackets the failure band.** It runs at
  3000×1500 and 393×852 — the only two rows in that table with zero overlap.
  A centred fixed overlay clears a 3000px toolbar and sits above a wrapped
  phone toolbar; it lands on the controls at exactly the widths a laptop
  uses. The new test pins its own widths for that reason.

The knowledge existed in the repo, in the wrong file: `index-test.html`'s
diagnostic banner carries the comment *"The banner is bottom-pinned (NOT
top-pinned) because Decap's editor toolbar is itself `position: fixed; top:
0`"*. One shell knew; nothing enforced it. Both files are now lint-locked
(`e2e/admin-329-shims.test.js`).

### 2.4 A five-to-fifteen-minute operation reports for fourteen seconds, then reports failure

After "Publish now":

1. `publish-via-auto-merge.js` shows a toast — removed after **14 s**.
2. Decap's own `publishUnpublishedEntry` catch fires (the shim hands it a
   deliberate 422) and flashes a red **"failed to publish"** error for 8 s.
3. Then nothing, for 5–15 minutes.
4. `deploy-status-pill.js` polls GitHub *Deployments*, which
   `deploy-production` only registers **after the merge** — so the entire
   required-checks phase, the longest part, has no signal at all.

The editor's complete feedback for the most consequential action in the
product is a toast that outlives the action by 0.2% of its duration,
immediately contradicted by an error message that is wrong.

### 2.5 The Publish control disappears while you have unsaved changes

`renderWorkflowControls` renders the publish dropdown only under
`!hasChanged`. Type one character and the button an editor was told to press
is gone, with no explanation. (The reported screenshot is the *other* half of
this: `CHANGES SAVED`, Save greyed out — the state where Publish *is* there,
under a banner.)

### 2.6 "Published" the toggle and "Publish" the button are different things

On adamdaniel.ai an entry can be published in Decap's sense (merged, deployed)
and render nowhere, because `published: false` in its front matter. The two
words differ by one letter and sit within a screen of each other. jodidaniel.com
has the site-level version of the same trap: `site_live: false` hides every
section of the site, and it is discoverable only by opening one particular
collection.

### 2.7 A publish can park on a gate no editor can even see

`visual-regression / approve-regression` is a **required** context on
`consumer-main`, and `visual-regression.yml` routes it through the manual
`regression-review` GitHub Environment whenever the PR has any visually
different page. Production lags `main`, so this fires on changes a visitor
would never notice (see AGENTS.md, "Approving `regression-review` on a
render-neutral PR").

For an editor, that is: pressed Publish, nothing happened, no error, forever.
The only remedy lives in the GitHub Actions UI or `/admin/reviews/`, and
nothing in the editor points at either.

### 2.8 Preview and production look identical, and the tell is the smallest thing on screen

The reported screenshot is `preview-pr220.jodidaniel.com/admin`. The one
element distinguishing it from the real site's admin is a 0.65rem pill in the
bottom-right corner reading `PREVIEW: claude/issue-26-site-live-on d268b15`,
while a full-width amber banner at the top instructs the reader to publish.
The most important fact on the screen — *nothing you do here reaches the
website* — is rendered smaller than everything else on it.

### 2.9 There are three status vocabularies for three states

- Editor toolbar: `Draft` / `In review` / `Ready`
- Workflow board columns: `Drafts` / `In Review` / `Ready`
- `statusDescriptions` in core: `Draft` / `Waiting for Review` / `Waiting to go live`

Plus the platform's own posts-list pill (`Published` / `Draft` / `Scheduled`),
which is derived from the `published` front-matter field — row 4 above, a
different axis entirely, using one of the same words.

---

## 3. The target model

Three principles, then the model.

1. **One question, one answer, one control.** For any entry an editor should
   be able to answer "is this on the website?" from one badge, and change it
   with one button.
2. **Never claim done before it is done, and never claim failure when it is
   working.** A 10-minute operation gets a 10-minute progress state.
3. **Only ever show a control that does something the editor can do.** A
   status that is really a publish trigger, a board with a different rule, a
   gate only a maintainer can clear — each is worse than absent.

### 3.1 Four states, one vocabulary, everywhere

Every entry, in the list and in the editor, carries exactly one badge:

| Badge | Means | Derived from |
|---|---|---|
| **Live** | On the public site right now | No open `cms/*` PR for it, and the last deploy carrying it succeeded |
| **Draft — only you can see this** | Saved, not on the site | Open `cms/*` PR, auto-merge not armed |
| **Going live… (about 10 minutes)** | Publish requested, in flight | PR armed or merged, deploy not finished |
| **Needs attention** | Something stopped it | A required check failed, a merge conflict, or a park on the review gate |

Two **modifiers** sit alongside the badge and are never merged into it,
because they are the editor's own choice rather than the system's state:
**Hidden** (`published: false`) and **Scheduled for &lt;date&gt;**
(`publish_date`).

And one **site-level banner**, permanent while it applies, on every screen of
the admin: *"The whole site is in coming-soon mode — nothing you publish is
visible to the public yet."* with the one control that changes it. A site can
be gated for months; discovering that from a boolean inside one collection is
not a reasonable thing to ask of anyone.

### 3.2 Two verbs

- **Save** — private, reversible, no consequence, always available. Copy
  never implies anything reached the website.
- **Publish** — one button, one click, one confirmation naming the URL and
  the ETA. Never a dropdown, never a second menu, never a status change.

"In review" is not a third verb, because on a two-person team nothing
consumes it: there is no notification, no queue, no reviewer. What that pair
actually does is *send each other a link*. So the review affordance is
**"Copy a preview link"**, which the per-PR preview environment already
builds — a real action with a real artefact, replacing a status nobody reads.

### 3.3 One place statuses live

The Workflow board goes away (`§4`, phase 2 — shipped). It is a second status surface
with a *different publish rule* (§2.1), it is where #329.9's contradictory
badges were seen, and everything it offers is available per-entry in the
collection list once the badge above exists.

---

## 4. Staged plan

Phases are ordered by (value ÷ risk). Everything from phase 2 on changes
publishing semantics for both live consumers, so each carries its own
verification bar; this repo's standing rule is that a green unit-lint lane is
not evidence for a Decap-DOM change.

**All five phases have shipped** — phase 1 with this document, phases 2–5 in
v0.1.96. Each section below now records what was built and why, rather than
what was planned.

### Phase 1 — shipped with this document

- `publish-step-hint.js` renders **in flow**, directly under the toolbar,
  never as an overlay. Zero overlap with every toolbar control, measured at
  1024/1280/1440/2000/3000 wide and at 393×852.
- It reports **two** states rather than one: the saved-draft state, and the
  unsaved-changes state that explains where the Publish button went (§2.5).
- Copy is shell-aware: the "about 5–15 minutes" clause appears only on the
  shell that has a real deploy to report, keyed off that shell's own
  `deploy-status-pill.js` tag.
- Guards, both proved able to fail: `expectNoInjectedOverlap`
  (`e2e/ui-visibility.js`, used by `e2e/admin-no-occlusion.spec.js` at pinned
  widths) and two pure-fs lints in `e2e/admin-329-shims.test.js` — no
  `position: fixed`, and compare-before-write on `textContent`.

Phase 1 deliberately did **not** close the second door (§2.2). It named one
route to publish; removing the other was phase 2, below, which has since
shipped.

### Phase 2 — one door — SHIPPED (v0.1.96)

`theme/admin/one-door-publish.js`, production shell only. The Status
dropdown, the Workflow nav link and the `#/workflow` route are CSS-hidden
and redirected, leaving Publish as the only route to production.
Mechanically it is the `native-preview-href.js` precedent — hide a Decap
control while leaving it in React's tree, never `removeChild`.

**The decision this needed was taken, and this is the record of it.** The
phase removes a capability rather than fixing a defect, so it was staged
behind an operator call; the operator's instruction was to complete all
five phases. Its cost, restated so a future reader can weigh a reversal:

- **Cost:** `pending_review` becomes unreachable from the production
  editor. Nothing on this platform consumes it (no notification, no queue,
  no required reviewer), and the label audit keys on `decap-cms/*`
  generally, so `decap-cms/draft` still satisfies it and the "adding
  labels…" dialog stays closed.
- **Scope:** production shell only. `cms-editorial-workflow.spec.js` and
  `cms-workflow-states.spec.js` drive the Status dropdown and the board on
  `index-test.html`, and that rehearsal surface keeps exercising Decap's
  real controls — which is the coverage that would tell us if Decap ever
  stopped behaving the way this shim assumes.
  `index-local.html` has no editorial workflow at all, so there is nothing
  there to hide. Both negatives are asserted, not assumed
  (`e2e/admin-publishing-ux.test.js`).

The route matchers are exported on `window.__oneDoorPublish` and unit-tested
(`e2e/admin-publish-routing.test.js`), because they are the part a Decap
router change would move, and because there is deliberately no browser spec:
the only served shell that loads this file is production.

### Phase 3 — one honest publish button — SHIPPED (v0.1.96)

`theme/admin/publish-button.js` replaces Decap's split button with a
platform-owned primary **Publish**, and CSS-hides Decap's — but only once
its own replacement is actually on screen. Hiding a control while failing
to provide its replacement is worse than either alone, so before the poller
has answered, nothing is hidden and Decap's own button stays.

The unlock is that on this platform *publishing is already "add a label to
a PR"*: Decap's synchronous merge always 422s against the branch ruleset,
and `publish-via-auto-merge.js` converts that into a `cms/ready` label. The
button adds that label directly, with the editor's own Decap token, against
the `cms/<collection>/<slug>` branch convention. That is **public API on
both sides** — GitHub REST and the DOM, no Decap internals — which is what
makes it safer than the click-forwarding tried and rejected under #329.2.

Three things it gets that the split button cannot:

- a confirmation naming the URL and the ETA, inline in the state bar rather
  than as a modal or a `window.confirm` (which is already wrapped, for
  Decap's backup dialog, by `confirm-wrap-local-backup.js`);
- a disabled state that says *why* (unsaved changes) instead of vanishing;
- a **re-publish that actually re-publishes**. `auto-merge-when-ready` fires
  on the `labeled` EVENT, and GitHub emits none for a label already present
  — so the second Publish press, which is the most likely one in the whole
  product because it follows a "Needs attention", would have returned 200
  and done nothing. The button removes the label before adding it.

It renders into the state bar's actions slot rather than the toolbar: the
toolbar is `flex-wrap: nowrap` on desktop and a fifth control squeezes the
other four at 1024 wide, and the bar is structurally incapable of covering
anything (§2.3).

### Phase 4 — a progress state that outlives the operation — SHIPPED (v0.1.96)

`theme/admin/publish-progress.js` polls the entry's own pull request, which
exists from the moment of Save, so the invisible 5–15 minutes stops being a
silence. It reports, in the editor, in words: **Going live… (about N
minutes left)** with what it is waiting on; **Live**; and **Needs
attention** naming the failure in plain English plus one action a
non-technical person can take.

Four details worth keeping:

- **The `regression-review` park (§2.7) is detected positively**, not
  inferred from silence: GitHub sets a workflow run's status to `waiting`
  exactly and only while it is pending a manual environment approval.
- **The ETA degrades to the range rather than inventing a number.** With no
  known start time `minutesLeft` is `null` and the copy says "about 5–15
  minutes". It also floors at one minute, because an ETA that reaches zero
  and keeps counting reads as broken.
- **Stopped outranks in-flight.** A PR whose checks failed is still
  *armed*, so an in-flight-first ordering would spin "Going live…" forever
  over a publish that stopped ten minutes ago. That precedence is the thing
  most likely to be "simplified" into a lie, so it has its own test.
- **A hidden tab polls nothing.** An admin left open overnight in a
  background tab must not spend the editor's rate limit on an entry nobody
  is looking at.

Also in this phase: Decap's misleading post-publish error toast is
suppressed — the one the shim's deliberate 422 provokes. The matcher
requires BOTH Decap's failure wording AND the marker string the 422 body
carries, so a REAL publish failure is never eaten; replacing a misleading
error with a silent one would be worse than the defect. The two literals
must move together, and `e2e/admin-publishing-ux.test.js` is what sees it if
they do not.

### Phase 5 — collapse the vocabularies — SHIPPED (v0.1.96)

`theme/admin/entry-status-model.js` is one derivation — four states plus
two modifiers (§3.1) — rendered by BOTH the editor bar
(`publish-step-hint.js`) and the collection list
(`posts-list-enhance.js`), in a sentence form and a chip form of the same
words. The posts-list pill's separate `Published / Draft / Scheduled`
wording is retired: the badge is now the "is it on the website" axis and
the front-matter axis renders beside it as the two modifiers.

The module is deliberately pure — no DOM, no network, and `now` is a
parameter — which is what makes every branch of it reachable in a Node vm
sandbox with no browser and no wall-clock dependency
(`e2e/entry-status-model.test.js`, 22 tests). That purity was a design
constraint rather than a happy accident: the alternative shape, where each
surface derives its own words from whatever facts it happens to hold, is
exactly how one product ends up with three vocabularies for three states,
and it is not testable at all without a browser.

The site-level banner is `theme/admin/site-gate-banner.js`. A site declares
its gate in `_config.yml` and both render paths inject it as
`window.CMS_SITE_GATE`:

```yaml
cms:
  site_gate:
    path: _data/settings.yml                          # file holding it
    field: site_live                                  # the boolean key
    entry: "#/collections/settings/entries/settings"  # where to change it
    label: coming-soon mode
```

A site with no gate — adamdaniel.ai, every scaffolded site — injects `null`
and the shim is inert. The banner is in NORMAL FLOW, not fixed: it is
permanent while it applies, and permanent chrome that overlays is
occlusion. (`oauth-app-restriction-detector.js` is fixed and correct to be:
it is a transient, dismissible alert.)

### What is deliberately NOT covered by a browser spec

Phases 2–4 load on the production shell only, and the only served shell a
browser spec in this suite can drive is `index-test.html` — which must keep
exercising Decap's own controls, because that is the coverage telling us
Decap still behaves the way these shims assume. Reading the shim sources off
the platform tree and injecting them into a synthetic page would break the
consumer-context rule the moment it ran on a consumer lane.

So the pure parts are exported and unit-tested instead — the status model,
and the route/branch matchers a Decap change would move — and the rest is
locked structurally by `e2e/admin-publishing-ux.test.js`. This is stated
here rather than left as an apparent gap, because "there is no browser spec"
is otherwise indistinguishable from an oversight.

## 5. Options considered and rejected

- **`publish_mode: simple`** (Save commits straight to `main`). It really
  would collapse the whole status model — and it deletes the per-PR preview
  environment, the required checks, the visual-regression gate and the
  editorial audit trail along with it. The complexity is not gratuitous; the
  *exposure* of it is the defect.
- **Forwarding the Publish button's click to the "Publish now" menu item**
  (#329.2 option (a)). Implemented and tested against a live instance under
  #329: activating the single `[role="menuitem"]` — by `.click()` and by a
  full synthetic pointer sequence — does not publish, and raises a page
  error. It is also the branch that risks a double-publish. Phase 3 replaces
  the control instead of driving it.
- **Reaching into Decap's Redux store** to read publish state directly. Every
  shim in `theme/admin/` is public-API-only by house rule; a Decap upgrade
  would break a store reference silently. The lints assert its absence.
- **Widening the visual-regression salience detector** so editorial PRs skip
  the review gate. That blinds the gate for every future PR, and both
  `e2e/visual-regression-content-skip.test.js` and `-skip-review.test.js`
  lock it. The fix for §2.7 is to *surface* the park, not to remove the gate.
- **Making the state bar a shorter chip inside the toolbar row.** It fits at
  1280 and squeezes the controls at 1024; the toolbar is `flex-wrap: nowrap`
  on desktop. A full-width row under the toolbar was measured to cost nothing
  at any width.

---

## 6. Reproducing the measurements

No production access and no consumer repo needed — the whole thing runs
against the in-browser `test-repo` backend.

```bash
# 1. The real pinned bundle, from npm (unpkg is 403 behind the egress proxy;
#    registry.npmjs.org is in the container's no_proxy list).
npm pack decap-cms@3.15.1 && tar xzf decap-cms-3.15.1.tgz

# 2. Decap's own source, from the bundle's source map — this is where the
#    two publish rules in §2.1 come from.
python3 - <<'PY'
import json
m = json.load(open('package/dist/decap-cms.js.map'))
for i, s in enumerate(m['sources']):
    if 'Editor/EditorToolbar' in s or 'Workflow/WorkflowList' in s:
        open(s.split('/')[-1], 'w').write(m['sourcesContent'][i])
PY

# 3. Serve the real admin shells with the bundle local, then drive
#    index-test.html (test-repo backend + editorial_workflow) with Playwright:
#    log in, open a collection, Save, and read getBoundingClientRect() for
#    the bar and for [class*="PublishButton"] / [class*="StatusButton"] /
#    button[class*="SaveButton"] / button[class*="DeleteButton"].
```

The overlap table in §2.3 is that rectangle intersection at each viewport,
with the pre-fix file and the post-fix file, in the same session.

---

## 7. Related

- `theme/admin/entry-status-model.js` — the four badges + two modifiers, and
  the only place any surface derives status words from. Pure; unit-tested in
  `e2e/entry-status-model.test.js`.
- `theme/admin/publish-progress.js` — the poller: which facts are read, from
  where, and the request budget that keeps a background tab silent.
- `theme/admin/publish-step-hint.js` — the state bar, and the placement
  rationale in full.
- `theme/admin/publish-button.js` — the platform-owned Publish button, and why
  it replaces rather than drives Decap's.
- `theme/admin/one-door-publish.js` — the second door, and what closing it
  costs.
- `theme/admin/site-gate-banner.js` — the site-level gate, and why it is in
  flow while the OAuth banner is fixed.
- `theme/admin/publish-via-auto-merge.js` — why publishing is a label, and the
  false-"Failed to publish" suppressor.
- `e2e/admin-publishing-ux.test.js` / `e2e/admin-publish-routing.test.js` — the
  structural and route-matcher halves of the guard set.
- `.github/workflows/cms-editorial-workflow.yml` — `auto-merge-when-ready`,
  the job that turns a label into a live site.
- `docs/CI-INVARIANTS.md` — the required-check topology behind the 5–15
  minutes.
- `docs/CONSUMER-COMPATIBILITY.md` — writing an e2e spec that survives a
  `base_collections: []` consumer.
- cms-platform#329 — the owner-persona testing this continues, 8 of 9 items
  shipped in v0.1.91–v0.1.92.
