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
| 3 | The **Workflow board** (`#/workflow`) | Decap nav | The same three statuses again, as a kanban, with the same Ready gate worded differently (§2.1) | Yes, and it repeats the editor's unexplained rule |
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

### 2.1 The same action is gated on Ready on two surfaces — and neither says so until it refuses

The reported complaint was that the admin "fails to instruct the user to first
change the status in order to be able to successfully publish." That rule is
**real**, and Decap enforces it on both surfaces that publish:

- **Workflow board** — `WorkflowList.requestPublish` hard-gates it:
  `if (ownStatus !== status.last()) { alert('Only items with a "Ready" status
  can be published. Please drag the card to the "Ready" column to enable
  publishing.'); return; }` — then a second `confirm()` before it proceeds.
- **Entry editor** — the toolbar's Publish dropdown renders whatever the
  status, but its handler gates too: Decap's Editor `handlePublishEntry`
  runs `currentStatus === status.last() ? … : window.alert(t("editor.editor.onPublishingNotReady"))`
  — *Please update status to "Ready" before publishing.* — and only a Ready
  entry gets the `confirm()` and the merge. (This section first read the
  dropdown's RENDER condition and called the editor ungated; the handler is
  where the gate lives. Corrected 2026-10-05, when an editor hit it — see
  Phase 3.)

So the rule is the same on both surfaces, and stated on neither until the
editor has already been refused: nothing on screen says the status is what
Publish waits for, and the three words ("Draft", "In review", "Ready") read as
a private note-to-self. Nobody could be expected to infer it, and no copy in
the product explains it.

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
would never notice (see `docs/OPERATIONS.md`, "Approving `regression-review`
on a render-neutral PR").

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

### 2.10 On a preview environment, Publish was a silent no-op (#371)

Everything in §2.8 is about the preview admin *looking* like production. This
is the same surface failing to *work* like it, and it is the §2.7 failure class
— "pressed Publish, nothing happened, no error, forever" — on a surface none of
the five staged phases covered.

`deploy-preview.yml` runs `scripts/patch-preview-config.sh`, which rewrites the
preview admin's `backend.branch` to the PR's head ref. That is deliberate: an
editor on a preview environment should edit that PR's branch. So Decap opens
its editorial PR with `base` = a feature branch, and
`cms-editorial-workflow.yml` labels it `cms/preview-only` (what that label
does and does not mean: §3.6).

Measured instance — jodidaniel.com [#233](https://github.com/jodidaniel/jodidaniel.com/pull/233),
created through `preview-pr220.jodidaniel.com/admin` on 2026-08-31:

| | |
|---|---|
| head → base | `cms/media/1-fda-amicus` → `claude/issue-26-site-live-on` |
| labels | `cms/draft`, `cms/ready`, `cms/preview-only`, `decap-cms/draft` |
| `editorial / auto-merge-when-ready` | **success**, in 4 s, at 22:05:25 |
| `editorial / validate-content` | **success**, at 22:06:27 |
| `mergeable` / `mergeable_state` | `true` / **`blocked`** |
| outcome | still open at 22:24, merged by hand by an admin |

**The four-second success is the tell, and it refutes the obvious reading.**
`auto-merge-when-ready` has a whole recovery path for a preview-only base — it
catches `enablePullRequestAutoMerge`'s "unstable status" error, polls up to ten
minutes for every non-self check to settle green, and then merges explicitly.
That path takes minutes. Four seconds means the GraphQL mutation did not throw
at all: **native auto-merge armed successfully**, which it can only do when the
base has something to wait for. The base was protected.

It was protected by `repo-settings.yml`'s `cms-feature-branches` ruleset, which
covers `refs/heads/cms/**`, `refs/heads/claude/**`, `refs/heads/feat/**` and
five more — and which required the status check **`validate-content`**. Nothing
publishes that string. The consumer's thin caller declares job id `editorial`
and `uses:` the platform reusable whose job id is `validate-content`, so the
check run GitHub publishes is `editorial / validate-content` — which is exactly
how `consumer-main`, twenty lines earlier in the same file, spells it.

A required context nothing reports never goes green, and a branch ruleset does
not time out. So every PR onto those refs was permanently `blocked`; auto-merge
sat armed against a check that could not exist; and the only thing that ever
moved one was a repository admin using the `bypass_actors` entry by hand —
which is why this survived unnoticed. The people who could merge never saw the
wall.

Three things this cost, all of them generalisable:

- **A required context is half a contract, and nothing checked the other
  half.** `cms-automerge-nudge.test.js` locks the nudge's `required_contexts`
  input against `consumer-main` — two lists against *each other*. Both could
  name a context nothing publishes and that lint stays green. The missing join
  is context-string → the workflow that would emit it, and it is now
  `e2e/ruleset-context-publishable.test.js`.
- **This was latent regardless of live state.** `scripts/audit-repo-settings.js
  --fix --yes` PUTs this manifest, so an unpublishable context in it becomes an
  unpublishable context live at the next reconcile, whatever the current drift.
- **`armed` was believed indefinitely.** Even with the server side fixed, the
  admin had no way to ever stop saying "Going live…", because nothing
  distinguished "the merge is coming" from "the merge is never coming". That
  half is §3.4 below.

### 2.11 A pattern error blocked Save and Publish with no feedback (#730)

A field with `pattern: [regex, message]` that fails blocks Save and Publish,
and Decap says nothing where the editor clicked. This is **Decap core, not
this repo**: `persistEntry` raises `ui.toast.missingRequiredField` only when a
field error has type `PRESENCE`; a `PATTERN` error just rejects the save, and
the message sits under the field. Decap's English `regexPattern` phrase
(`%{fieldLabel} didn't match the pattern: %{pattern}.`) also wrapped the
site's own sentence, which usually ends in a period (hence "..") and was
upper-cased by Decap's error styling (`/pages/about/` read `/PAGES/ABOUT/`).

`theme/admin/validation-feedback.js` (all three shells, deferred after
`decap-cms.js`) works around it without touching Decap internals: it rewrites
the phrase to `%{fieldLabel}: %{pattern}` through `CMS.getLocale('en')`, turns
the upper-casing off for `[class*="ControlErrorsList"]`, and after a click on
Save or Publish scrolls to the first field error and toasts its message unless
Decap raised its own toast. Each piece is a silent no-op if Decap changes the
surface it reads. A site's `pattern` message should therefore be a complete
sentence that says what to enter, with its own final punctuation. The upstream
gap (no toast for non-presence errors) is a candidate for a Decap issue; this
shim can be deleted if it closes. Unit test: `e2e/validation-feedback.test.js`.

Follow-ups (#750): the toast goes on the screen edge the field is not near,
passes every click through except on its own "Dismiss" button, and names the
list row when the field sits in one ("Item 2 (Beta): URL: ..."), opening the
row if it is collapsed. "Decap raised its own toast" means a toast that
appeared after the click: Decap's missing-field toast outlives its click by
8 s, and a format error retried inside that window used to find it, stand
down, and leave "you missed a required field" on screen for a bad format
(reproduced on Decap 3.15.1). A leftover "missed a required field" toast is
now closed when the shim shows its own; any other leftover error toast
("logged out", "backend unavailable") is left open (#752). The shim matches
the toast's text against `ui.toast.missingRequiredField` of every locale Decap
ships (read through `CMS.getLocale`), since it cannot read the site's
configured `locale`; a toast in a locale it cannot read stays open. The
"Dismiss" button is at least 24 x 24 px (44 x 44 on a touch screen) with its
"×" glyph `aria-hidden`, and the toast is centered with auto margins so it
keeps its width on a phone.

Follow-up (keyboard Publish, UX round 3): Enter or Space on "Publish now" gave
no feedback at all. The Publish menu is react-aria-menubutton, which selects an
item on `keydown` and fires no `click`, so the shim's click listener never ran
(the mouse path worked). A capture-phase `keydown` listener now treats Enter or
Space on a `role="menuitem"` Save/Publish item as the same attempt (a real
`<button>` is skipped: its own Enter fires a click, so Save reports once). After
the scroll, focus moves to the first input in the first failing field (a
collapsed list row is opened first), also when Decap raised its own "missed a
required field" toast, so a keyboard or screen-reader editor lands on the field
the message names instead of staying on the Publish button. Focus moves only
for an event the editor made (`isTrusted`): `autosave-on-hide.js` clicks Save
from a script on tab hide, page hide and idle, and that report still toasts and
scrolls but must not move focus out from under her typing. A held key
(`repeat`) is ignored, and a field in a row opened a moment ago is waited for (a
few frames) before it is focused. Under
`publish_mode: editorial_workflow` Decap's Publish never validates; the path
only exists in simple mode (the local backend), which
`e2e/cms-validation-feedback.spec.js` selects by rewriting `config-test.yml`.

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
| **Draft — not on the site yet** | Saved, not on the site | Open `cms/*` PR, auto-merge not armed |
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
repeating the editor's unexplained Ready gate (§2.1), it is where #329.9's contradictory
badges were seen, and everything it offers is available per-entry in the
collection list once the badge above exists.

---

### 3.4 A publish that stops must stop saying it is in flight (#371)

`armed` — a `cms/ready` label, or native auto-merge enabled — was read as "on
its way", and believed for as long as the tab stayed open. Every failure of the
merge machinery therefore rendered as **Going live…**, indefinitely. §2.4's
defect was feedback that outlived the action by 0.2% of its duration; this is
its opposite number, and it is worse, because it is confident.

The signal that closes it is **positive and needs no threshold guess**: a PR
that is armed, has at least one check run, has *no* incomplete check run,
nothing red, no conflict and no review-gate park has **nothing left to wait
for** — so if it is still open, the merge is not coming on its own. That is a
fact about the PR, not an elapsed-time heuristic, and it is true whatever the
underlying cause: the unpublishable required context of §2.10, the
`automated-test` scoping that keeps `cms-automerge-nudge.yml` off a real
editor's draft, or anything that replaces either.

One timestamp is still recorded rather than reporting instantly, because there
is a legitimate seconds-wide window in which the condition holds: native
auto-merge fires a moment *after* the last check completes. `publish-progress.js`
reports `settledSince` — when the condition first held continuously, reset on
any change of PR or head sha — and `entry-status-model.js` applies the grace
(`STALL_GRACE_MIN`, 3 minutes). The threshold lives in the pure module, so both
surfaces read one verdict and the poller stays a fact-gatherer.

Reporting a healthy publish as stopped is the same class of lie as reporting a
stopped one as in flight, so both directions are tested:
`e2e/entry-status-model.test.js` pins the badge on either side of the boundary,
at the boundary, and for both unknowns (`settledSince` absent, `now` absent),
where the answer must be "not stalled" — an unknown must never manufacture a
failure report.

### 3.5 On a preview, "the website" is the wrong noun

An editor on a PR-preview deploy is editing a feature branch. So every
sentence in the admin containing "the website" was false there — including the
Publish confirmation's **"It will appear at https://&lt;apex&gt;/… in about
5–15 minutes"**, a specific, checkable, false promise on a surface where
nothing reaches the live site *now*.

`entry-status-model.js` now derives the destination once (`destination(facts,
options)`), and both the bar and the button name it. The bar and button pass
`site-hostname.js`'s served-config `destination()` as the model's
`currentHostname`; `canonicalHostname` remains the production hostname from
`canonical()`. Opening the admin on the destination itself keeps the same copy.
On a preview, the former names where this publish goes and the latter names where
it does not go. When both hosts are the same, the model keeps the honest branch
description rather than inventing a preview URL. `publish-progress.js` supplies the fact
from two free signals on the `/pulls` list response it already makes — the
`cms/preview-only` label, or `base.ref !== base.repo.default_branch` — so it
costs no extra request and hardcodes no branch name.

The deploy-status pill and Posts-list summary follow the same rule. A production
update names the canonical hostname; a preview update names the current preview
hostname. Their visible labels and help text describe publishing and updates,
while workflow names, job ids and deployment states remain internal diagnostics.

Publication links use `CMSHostname.destinationOrigin()`: the HTTP(S) origin of
the served config's `site_url`, including protocol and port, with paths and
credentials removed. They resolve it when rendered, so a delayed config read
changes the destination without reloading. The local/test config names
`http://localhost:4000`, intentionally preserving local development's protocol
and port. The publish button supplies a site fallback explicitly:
`CMS_SITE_ORIGIN`, then `https://` plus `CMS_APEX`. A served preview or local
origin takes precedence; before the config settles, or when it is unreadable,
times out after 10 seconds, or names a non-HTTP(S) URL, the button uses that
supplied fallback.
Other callers retain the no-argument `publicOrigin()` default: the configured
public site on a separate admin origin, otherwise this tab's origin. A cached
older hostname helper still supplies `publicOrigin()` to live-URL derivation
until the new helper is available.

New-post slug-collision probes intentionally use the tab's own origin for the
`HEAD` request. A cross-origin response may be rejected by CORS, which would
silently treat an occupied address as free; a same-origin response is readable.
The probe remains best-effort and uses its existing timeout so Save can
continue if a response is unavailable.

Live Preview keeps the tab's origin because its BroadcastChannel is
same-origin. The branch-binding banner likewise names the tab with `current()`;
it identifies the preview the editor opened. The site-gate banner uses the same
`binding()` result as the destination helpers, reads its flag at that served
branch (#528), and names `canonical()` for the production branch or
`destination()` for a preview. These banners explain the editing surface and
its visibility; publication labels name where the configured publish goes.

Every deployment state GitHub documents has its own words in the Posts-list
summary (#534): *updated*, *update did not finish*, *update started*, *update
requested*, and, for `inactive`, *update replaced by a newer one*. A state the
code does not recognize reads *update status unknown (last reported 5m ago)*,
never the old *publishing details*, which read as if something had happened.
When polling breaks for five minutes, the toolbar pill turns amber with *details
may be out of date*, names the same production or preview hostname as before,
keeps its link to the last update, and clears on the next successful poll
(`e2e/deploy-status-pill-stale.test.js`; before #534 the warning outlived the
outage until the deployment changed state).

§2.8 measured the only thing distinguishing a preview admin from the real one
as a 0.65rem pill in a corner. This puts it in the sentence the editor is
already reading.

### 3.6 What a preview-only edit does when its branch merges (#532)

The `cms/preview-only` label used to describe itself as *"drop this content
from the parent branch when it merges to main"*, and the admin echoed it:
"It will not go to &lt;apex&gt;", "It will NOT go to &lt;apex&gt;". Nothing
does that. Traced end to end:

1. Decap opens the PR with `base` = the feature branch (§2.10), and
   `cms-editorial-workflow.yml`'s "Apply draft label on new PR" step labels it
   `cms/preview-only` because `base.ref !== 'main'`.
2. Publishing it merges it **into the feature branch** —
   `auto-merge-when-ready`'s preview-only path, with
   `cms-automerge-nudge.yml`'s `basePreviewOnly` branch as the backstop.
3. The edit is now an ordinary commit on that branch. When the feature branch
   merges to `main`, the edit goes with it and production deploys it. No
   workflow, script or check removes it, and nothing reads the label after it
   is applied except the admin's own `previewOnly` fact.

So the policy is the reworded one: **a preview-only edit reaches the live site
when its branch does, unless someone removes it by hand first.** The label now
says *"CMS edit on a feature-branch preview; reaches main when that branch
merges, unless removed by hand"*, and every preview sentence about the live
site uses one phrase from `destination().laterNote`: *"It will not reach
&lt;apex&gt; until the work on “&lt;branch&gt;” goes live there."* That is true
whether or not the branch ever merges, and an editor reading it before the
parent PR merges knows the edit rides along. Locked by
`e2e/entry-status-model.test.js` (Draft and Going-live, with and without a known
branch, the stall, and Live on the preview), `e2e/publish-status-links.test.js`
(the confirmation) and `e2e/publish-progress-post-merge.test.js` (once the PR
has merged, only a merge into a known default-branch base reads as going live
on the live site, whatever its labels; a merge into the feature branch, or one
whose base is unknown, reads as on its way to the preview for the merge watch,
and after that the entry's ordinary state applies). Within the watch, a
feature-branch merge reads Live, "on &lt;preview host&gt; now", as soon as a
`preview-pr-<N>` deployment covering the merge succeeds — N being the open PR
whose head is that branch (#643); before #643 nothing read that deployment,
so the bar said "Going live…" for the whole 30-minute watch.

The old wording was never actually shown on GitHub. GitHub rejects a label
description over 100 characters with a 422; the old one was 107, the
`createLabel` call sat in a `try { … } catch (_) {}`, and `addLabels` then
created the label implicitly with no description and the default grey. Both
consumers' `cms/preview-only` labels read exactly that (description `null`,
color `ededed`, 2026-10-03), while `cms/draft` and `cms/ready` from the same
step carry their descriptions. `e2e/preview-only-label-description.test.js`
parses every platform workflow's `createLabel` call (`yaml` + acorn) and holds
each description to 100 characters; a call shape it cannot evaluate fails it,
as do other ways to create `cms/preview-only` (a github-script `request()` to
`POST …/labels`, `eval`, a `run:` step's `gh label create` or `gh api …/labels`).
Its scope is the platform's workflows; repo scripts that create other labels
are out of it, and a test fails if one under `scripts/` names
`cms/preview-only`.
The preview-only step now raises a warning with the HTTP status code (never
the response body) for any failure other than `already_exists`, and the same
lint holds every `createLabel` handler to that (acorn AST, never a regex):

- **A failure may not be swallowed**, however the promise is written: a
  `try`/`catch`, `.catch(fn)` where `fn` is a function literal or an
  identifier the script binds once to a function (`.catch(noop)`), a `.catch`
  after `.finally()`, `.then(null, fn)`, a promise held in a variable and
  caught or awaited later, and `Promise.all`/`race`/`any`. `Promise.allSettled`
  never rejects, so its results must be bound and some statement that reads
  them must report. A handler throws or calls `core.warning`/`error`/
  `setFailed` or their resolved aliases; an empty or comment-only body, an unused
  error binding and a nested function alone are silent, even when the handler
  calls that function.
- **The lint fails closed** on a callback it cannot resolve (an undeclared or
  twice-bound identifier, `core.warning` passed as the callback, a callback
  built by a call) and on a promise that flows somewhere it cannot follow (an
  argument, an array, a function's return). It does not follow a function
  that awaits the call and propagates, whose callers swallow it; every
  handler here is top-level.
- **Handler output carries only the HTTP status and a bounded type.** Arguments of
  `console.log`/`error`/`warn`/`info`/`debug`,
  `core.warning`/`info`/`notice`/`error`/`setFailed`/`setOutput`/`debug`/
  `exportVariable`, every method chain rooted at `core.summary` (including
  fluent calls), and `process.stdout.write`/`stderr.write` are checked,
  including every argument and outputs beside a clean warning. The sinks
  include static computed spellings such as `console['error']` and lexical
  aliases such as `const log = console.log` or `const { warning: report } = core`,
  including declarations outside the handler and summary builder aliases.
  Known sinks also remain sinks through `bind`, `call` and `apply`, including
  static computed methods and extracted adapter methods such as
  `const { call: invoke } = core.warning`. A `bind` creation checks its bound
  arguments even if the result is never called; only invoking the bound result
  counts as reporting. `call` and `apply` invoke immediately, and an `apply`
  argument array or tainted array alias is checked. Adapter `thisArg` values
  are conservatively checked as output too. Summary methods invoked through
  `call` or `apply` retain the summary builder for following fluent output
  checks. Adapters of adapters, such as
  `core.info.call.bind(core.info, null)(e.message)`, remain unmodeled.
  Aliases conservatively retain every assigned sink; an unknown replacement
  prevents an alias from satisfying reporting but preserves its output checks.
  The added sinks do not change the reporting rule above: an info message, notice,
  console call or output alone still silently catches the failure.
  Thrown expressions are checked too, including `new Error(e.message)` and
  a constructed error stored in a local; direct `throw e` propagation of an
  unreassigned caught binding remains allowed. Assignments, updates or
  initialized declarations replacing that binding remove the exemption,
  including `e = new Error(e.message); throw e`. Member writes such as
  `e.status = 500` and uninitialized `var e` do not replace the binding.
  Constructor arguments use the same bounded rules as logging arguments.
  Output and the direct-rethrow exemption use lexical binding identity: block,
  loop, switch, nested catch and function shadows stay separate, `var` is
  function-scoped, and `let`/`const` are block-scoped. A shadowed `e` does not
  inherit the caught error's taint or direct-rethrow exemption, and the outer
  binding remains in force after leaving the shadow's scope. Output is checked
  against the caught error's binding and every local derived from it: only
  `.status` (also `.response.status`, and
  `.reason.status` for an `allSettled` result), `Number(…)` of anything, and
  a choice between fixed strings are allowed. `e.message`, `e.response`, the
  body, the bare error, `String(e)`, `JSON.stringify(e)` and a local copied
  from them fail it. A conditional's test and comparisons are not logged, so
  they may read the error (the `already_exists` check does).
  Simple local aliases, `msg += e.message`, member assignments and array
  `push`/`unshift`/`splice` propagate taint, including mutation through an
  identifier alias followed by output through the original array. This is a
  conservative fixed point: it does not model execution order, unreachable
  branches or whether an alias holds a primitive or an object, and does not
  clear taint after a safe reassignment, so an overwritten caught name may
  conservatively fail even when its replacement is bounded. It does not follow
  arbitrary mutator calls, dynamic sink methods, transformations in another
  function or aliases through nested object properties. All nested function
  bodies are excluded from handler report/output scanning, whether called or
  uncalled. A handler calling a nested helper still needs an inline warning or
  throw; leakage inside such helpers is not detected. For example, a called
  helper logging `e.message` alongside an inline fixed warning passes this lint.
  Taint collection still visits nested bodies conservatively and resolves their
  lexical bindings, so a captured outer assignment can taint inline output even
  when the helper is uncalled. The separate explicit `allSettled` result
  inspection scans callbacks on those results. Following helper calls, arguments
  and returns requires separate interprocedural design; the lint counts report
  syntax and makes no broader reachability claim.

`createLabel` never updates a label that already exists (it answers 422
`already_exists`, which the step ignores), and no audit or sync in this repo
edits a label's description. A consumer whose `cms/preview-only` label already
exists keeps its old description and color until someone edits it by hand:
`gh label edit cms/preview-only --repo <owner>/<repo> --description "…" --color f5a623`.

`e2e/entry-status-model.test.js` pins the fallback explicitly: a preview-only
entry encountered on the canonical host degrades to "the preview for this
branch", never to a guessed URL.

The preview fact still comes from the entry's open pull request. With no open
PR, `publish-progress.js` reports `previewOnly: false`, so a steady Live entry
opened from a preview admin is described with the canonical hostname. The
browser hostname alone cannot prove that the entry belongs to a preview-only
workflow, so the model does not infer that state.

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
- a disabled state that stays visible while the state bar says *why* once
  (unsaved changes), instead of vanishing;
- a **re-publish that actually re-publishes**. `auto-merge-when-ready` fires
  on the `labeled` EVENT, and GitHub emits none for a label already present
  — so the second Publish press, which is the most likely one in the whole
  product because it follows a "Needs attention", would have returned 200
  and done nothing. The button reads the current PR detail with
  `cache: "no-cache"` and removes `cms/ready` only when present before
  adding it. The PR detail includes the complete label set, avoiding a
  paginated label-list read and a needless DELETE 404 on a first publish.
  A racing DELETE 404 is successful removal; other read/removal failures
  stop before the add and show a retry error. Console warnings contain only
  a numeric HTTP status or `unknown`, never an API body or thrown Error text.
- a **Publish that does not trust a stale snapshot** (#386). The poller
  reads the PR every 30 s and on `hashchange`, and saving an EXISTING entry
  changes no hash — so a Publish pressed right after Save could read the
  snapshot from before Decap opened the PR and render "could not be
  published right now" over a PR that was there. With no PR in hand
  `doPublish()` now asks the poller to re-read, a bounded few times, before
  it says so. `e2e/publish-button-refresh.test.js` drives it in a vm
  sandbox. **The half that made this unfixable from the button alone is
  the browser's HTTP cache:** GitHub REST answers carry `Cache-Control:
  private, max-age=60`, a browser `fetch()` honours it, and so for a minute
  after any GET every `refresh()` returned the same cached body — measured on
  adamdaniel.ai run 33580693718, where the bar could not see the `cms/ready`
  label its own click had applied for 58 s (every `/pulls` read answered in
  1 ms). Every GitHub GET in `theme/admin/` now passes `cache: "no-cache"`;
  `e2e/admin-github-fetch-cache.test.js` holds the line for every shim.
- **Decap's own "Publish now" goes through the same route** (2026-10-05).
  Until the poller has found the entry's PR — up to one 30 s poll after
  saving an EXISTING entry, which fires no `hashchange` — the button is not
  on screen and Decap's split button is. Its "Publish now" then hit the
  status gate in §2.1 and alerted *Please update status to "Ready" before
  publishing.*, on a shell where `one-door-publish.js` hides the Status
  control: a dead end, reported on jodidaniel.com's custom "Expertise"
  collection, though nothing about it is collection-specific. A
  capture-phase listener in `publish-button.js` now takes a selection in the
  dropdown whose trigger is Decap's `PublishButton` before Decap's React
  handler sees it, and runs `doPublish()` — the `cms/ready` label with the
  bounded re-read above. Choosing the menu item is the second deliberate
  step, so no third confirmation is added; with no state bar on screen a
  failure is said in an `alert()`, as Decap would have. The published-entry
  dropdown (Unpublish, Duplicate) and the rehearsal and local shells are
  untouched. `e2e/publish-button-decap-menu.test.js` drives it in a vm
  sandbox against the dropdown's real react-aria-menubutton shape.

Labels on a merged editorial PR are historical metadata. The
[publish button](../theme/admin/publish-button.js)
changes only `cms/ready`, leaving Decap's `decap-cms/<status>` label as Decap
set it; `cms/draft` can therefore remain alongside `cms/ready` and
`decap-cms/draft` after a successful publish. These labels do not override
the merged state. The [editorial caller](../examples/site/.github/workflows/cms-editorial-workflow.yml)
listens for `opened`, `synchronize`, and `labeled`, with no `closed` cleanup,
and the [editorial label audit](../scripts/audit-editorial-labels.js) examines
only open PRs. The current design retains these labels after publication.

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
  is looking at. A Publish press is the exception (unreleased, #644): its
  `refresh()` reads in a hidden tab too, because an editor who pressed
  Publish and switched to the Live Preview tab got "press Publish once more"
  with no Publish control on screen. That failure now also gives Decap's
  control back when no button of ours is showing, and the admin shims that
  coalesce on `requestAnimationFrame` (which never fires in a hidden tab)
  run their pass on the next task instead while the tab is hidden.
- **The sentence links to the run (unreleased).** "did not pass" links to
  the failed check's workflow run, and the "It is waiting for …" phrase to
  the running one (one run's page when the running checks share a run, else
  the PR's Checks tab). The poller reads the URL off the check-runs response
  it already fetches (`checksUrl`, no extra request); the model links only an
  `https://github.com/` URL, because a check run's `details_url` is whatever
  the app that wrote it chose. The sentence still names a person to ask: the
  link is for that person. The deploy phase after the merge is not linked.
- **The Draft sentence steps aside for the confirmation (unreleased).**
  "…Click Publish to put it on <site>." beside publish-button.js's "Put
  this on <site>? …" says the same thing twice, so the bar hides the Draft
  sentence while the confirmation (or the send it leads to) is on screen,
  and restores it on Cancel. The bar asks `window.CMSPublishButton` what is
  rendered, not what `mode` is set to. `e2e/publish-status-links.test.js`
  covers both.
- **Owner-pass wording and layout fixes (#625 items 1, 2, 4, 5, 6, 7).**
  - *Gate-aware copy (1).* On a coming-soon (gated) site the Draft bar and the
    "Publish this to <site>?" confirmation say that publishing saves the entry
    to the site but visitors keep seeing the coming-soon page until the site
    is switched on, instead of "it then takes about 5 minutes to appear".
    The gate state is not fetched again: `site-gate-banner.js` already resolves
    it (branch-aware, cached) and shows `#cms-site-gate-banner` exactly while the
    site is gated, so `CMSEntryStatus.isSiteGated()` reads that banner's presence.
    Not gated, no gate declared or not yet resolved reads as not gated and the
    live-site wording is unchanged.
  - *No "Changes saved" on a never-saved entry (2).* On a `#/collections/<c>/new`
    route `publish-step-hint.js` hides Decap's "Changes saved" toolbar status
    (`visibility`, so nothing reflows) until the entry has a saved route.
  - *Reload toast (4).* `confirm-wrap-local-backup.js` now says, in owner
    language, that work is saved automatically and by Save and that nothing
    reaches the site until Publish; bottom-right, narrow, 7 s (was a centred
    560 px toast for 14 s over the form).
  - *Draft label (5).* "Draft — only you can see this" was untrue (the draft is
    a public PR); it is now "Draft — not on the site yet".
  - *No layout shift (6).* The bar keeps its row (`min-height`) on every editor
    route, empty and invisible when it has nothing to say, so its first
    appearance no longer pushes the fields down ~46 px. Publish is already
    rendered in the bar once the poller has found the entry's PR; Decap's own
    toolbar "Publish ▾" is only visible before that (the hide-nothing-until-
    there-is-a-replacement rule above), so it is not moved.
  - *Unpublish explained (7).* The "Unpublish" item in the published-entry
    dropdown carries a plain `title`: it takes the entry off the site and moves
    it back to Drafts. `e2e/publish-button-unpublish-hint.test.js`.

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

### The branch binding — a tenth status, stated once (#412, v0.1.107)

`deploy-preview.yml` patches the served `admin/config.yml`
(`scripts/patch-preview-config.sh`), so a preview's `/admin` is bound to the
**PR branch** — `backend.branch` is the PR head, `site_url` the preview host.
That is the point of a preview admin. What was missing is that nothing on
screen said so: the two admins are byte-identical apart from that one config
line, an editor reaches the preview one routinely (the preview bot links it
on every PR), and every string written for production — "publish", "the
site", "visible to the public", the gate banner above included — was read
verbatim on a surface where it was false. Measured on jodidaniel.com,
2026-09-04:

```
$ curl -s https://jodidaniel.com/admin/config.yml               | grep '^  branch:'
  branch: main
$ curl -s https://preview-pr247.jodidaniel.com/admin/config.yml | grep '^  branch:'
  branch: claude/controls-gating-label-or72js
```

Per-field copy cannot carry this — it is a property of the surface, not of
any field — so `theme/admin/branch-binding-banner.js` states it once, at the
top of every screen, on the surface where it is true:

> You are editing the `<branch>` branch from a preview. Anything you save or
> publish here updates this preview only — it reaches `<apex>` when *this
> pull request* merges.

Three decisions in it, each with a shorter wrong alternative:

- **The verdict is read from the config, never guessed from the hostname.**
  The shim fetches the same `config.yml` Decap loads and reads
  `backend.branch` at the line anchor the patch script WRITES (`^  branch:`);
  `e2e/branch-binding-banner.test.js` runs the real script on the real
  template and feeds the bytes to the real reader, so writer and reader
  cannot drift apart unnoticed. A `/^preview-pr\d+\./` hostname test would be
  shorter and would silently disable the banner the day a preview host is
  renamed — the exact failure the banner exists to remove — so the lint
  forbids any `location` read at all.
- **It compares against `window.CMS_PRODUCTION_BRANCH`, a new injected
  global, not a `"main"` literal.** Both render paths read `backend.branch`
  back off the `config.yml` they have just rendered (a real YAML parse) and
  inject it — the branch the admin binds to when that file is served
  UNPATCHED. "Which branch is production" is site identity, and the shim
  carries no branch name; `e2e/admin-publishing-ux.test.js` asserts it never
  grows one, the way it already does for `publish-progress.js`.
- **It renders before login.** The config is public and needs no token, so
  an editor who follows a preview link sees which branch they are about to
  edit before they authenticate into it.

The gate banner's copy was re-read for the same reason ("`<host>` is in
coming-soon mode — its visitors see the coming-soon page, not what has been
published…"). Since #528 the flag is read at the branch the admin is bound to
(the served `backend.branch`, as `?ref=`), because each surface is built from
its own branch and a preview can carry the opposite value; `<host>` is the
canonical host on the production branch and the preview host otherwise, and
the cached value is scoped to the branch. When both banners
render, the branch banner is always first and the gate second, whichever
async read resolves first (the gate banner anchors below the branch
banner's id).

**"In flow" was not enough, and the gate banner had been invisible on the
editor route since v0.1.96.** Decap 3.15.1's `EditorContainer` is
`position: absolute; top: 0; height: 100%` and `ToolbarContainer` is
`position: absolute; top: 0` inside it, with NO positioned ancestor — so on
the entry editor they anchor to the viewport, not the flow. Measured with the
real bundle while #412 was built (both banners in flow at body's top,
126 px):

| viewport | route | banner y | toolbar y | `elementFromPoint` at the banner |
|---|---|---|---|---|
| 1280x800 | login, list | 0 / 64 | 126 (sticky header) | the banner |
| 1280x800 | entry editor | 0 / 64 | **0** | a toolbar button; the split-pane resizer |
| 393x852 | all three | 0 / 122 | 271+ (static, mobile layer) | the banner |

The list and login routes and the phone were fine, which is how "on every
screen" shipped while false on the one screen an editor lives in. The fix
is `theme/admin/admin-notice-band.css`: each banner adds `cms-notice-band`
to `<body>` when it renders, and under that class body is a flex column at
least the viewport tall with `#nc-root` (Decap's mount point) positioned and
filling the remainder — the editor's `height: 100%` resolves against that
box, so it anchors below the notices with no document scrollbar. Re-measured
after the fix at 1280x800 on the entry editor: toolbar y=126, editor
126–800, Save reachable, `documentElement.scrollHeight` 800. A site with no
banner never gets the class and sees no layout change at all.

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

### Two shim hazards recorded after the phases shipped (v0.1.97)

Both surfaced driving the shipped shims, not building them, and neither
is visible to a pure-fs lint.

- **`mergeable` is absent from the `/pulls` LIST response** — only the
  single-PR endpoint carries it, and it is `null` until GitHub computes it.
  Reading it off the list leaves a merge-conflict branch that looks alive and
  can never fire.
- **Hiding a control RETARGETS every selector that matched it by name**, and
  that is how v0.1.96 broke every real-prod loop while 1656 pure-fs
  assertions stayed green. `publishViaUi()` did
  `getByRole("button", {name: /^Publish$/i})`; `getByRole` skips CSS-hidden
  elements, so it skipped Decap's newly-hidden control and resolved to the
  PLATFORM's `#cms-publish-button` — same accessible name, different control.
  The click SUCCEEDED, opened the inline confirmation, and only the following
  `publish now` menuitem lookup failed. A missing control fails loudly; a
  silently retargeted one fails two steps later somewhere else. When a shim
  hides a control, audit what selects it by ROLE AND NAME, not just by class
  — and remember that the replacement is labelled with the right word for an
  editor, which is exactly what makes it a drop-in for someone else's
  selector. (v0.1.97, adamdaniel.ai run 33439336337.)

### A spec that publishes in two entries through one page fails (#342)

Decap 3.15.1 breaks the next publish after a direct hash navigation from one
ENTRY route to another (`#/collections/a/entries/x` → `#/collections/b/entries/y`):
the publish throws `Cannot read properties of undefined (reading 'reduce')`
inside the bundle, nothing reaches disk, and no toast reports it — the editor
just stays dirty. Visiting the first entry without editing it is enough to arm
it. Opening the entry first in the session, or going list → entry, both work.
Reproduced byte-identically with and without the platform's shims, so it is
Decap's, not ours — https://github.com/Adam-S-Daniel/cms-platform/issues/342
tracks it upstream (no Decap issue exists yet).

An editor cannot reach it: the editor chrome renders no sidebar, and the back
link goes to the COLLECTION route. A spec reaches it by default, because specs
navigate with `page.goto("…#/collections/…/entries/…")`. So, for any spec that
publishes:

- **One publish per page.** A scenario that publishes a second entry gets its
  own `test()` (Playwright's `page` fixture is per-test) or an explicit
  `browser.newContext()`. Never drive two entry publishes through one page
  object, even when the first entry was only visited.
- **Between entries, route through the collection.** If one test genuinely
  must touch two entries, `goto` the collection route (or click the
  "← Writing in …" back link) before the second entry's route. List → entry
  is a working path; entry → entry is the broken one.
- **It does not present as a Decap error.** It presents as a publish that
  "did nothing" — dirty editor, unchanged file, a downstream wait that times
  out — and it cost two spurious failures in the #329 acceptance suite before
  it was isolated. Read the browser console for `reading 'reduce'` before
  debugging the publish path.

No lint enforces this yet. If it bites again, the publish-path AST lint from
https://github.com/Adam-S-Daniel/cms-platform/issues/382
(`e2e/status-dropdown-selector.test.js`) is where a "two entry routes, one
page, then publish" detector belongs. The
`browser-testing` skill carries the same rule beside the other Decap-driving
gotchas.

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
#    two publish gates in §2.1 come from.
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
- `theme/admin/branch-binding-banner.js` — which branch a preview admin is
  bound to, read from the served config (#412); with
  `theme/admin/admin-notice-band.css`, the positioned ancestor that keeps
  Decap's viewport-anchored editor below both banners, and
  `e2e/branch-binding-banner.test.js`, the writer↔reader lockstep test.
- `theme/admin/publish-via-auto-merge.js` — why publishing is a label, and the
  false-"Failed to publish" suppressor.
- `e2e/admin-publishing-ux.test.js` / `e2e/admin-publish-routing.test.js` — the
  structural and route-matcher halves of the guard set.
- `e2e/ruleset-context-publishable.test.js` — the §2.10 guard: every required
  status-check context in `repo-settings.yml` must be one the workflow tree can
  actually publish.
- `.github/workflows/cms-editorial-workflow.yml` — `auto-merge-when-ready`,
  the job that turns a label into a live site.
- `docs/CI-INVARIANTS.md` — the required-check topology behind the 5–15
  minutes.
- `docs/CONSUMER-COMPATIBILITY.md` — writing an e2e spec that survives a
  `base_collections: []` consumer.
- cms-platform#329 — the owner-persona testing this continues, 8 of 9 items
  shipped in v0.1.91–v0.1.92.
