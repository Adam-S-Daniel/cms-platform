# Decap caret-selection diagnostic (#755)

[Issue #755](https://github.com/Adam-S-Daniel/cms-platform/issues/755) reproduces
with the pinned stock Decap bundle before any platform script runs. Hiding the
preview does not prevent the fault. This diagnostic leaves platform selection
handling unchanged and provides evidence for an upstream report.

## Fixture and isolation

The neutral Body is exactly:

```text
Alpha paragraph has several words.

Bravo paragraph also has several words.
```

The only other field is Title, `Neutral caret probe`. The official in-browser
`test-repo` backend seeds one published entry, so no OAuth, local proxy, save,
publish, or real repository is involved. A Playwright route serves a neutral
shell at `http://localhost:4355/admin/caret.html`; no server listens on that port.
Every browser request is fulfilled locally or answered with an empty 404.

The stock comparison loads only
[Decap 3.15.1](https://unpkg.com/decap-cms@3.15.1/dist/decap-cms.js), exactly as
pinned in [the local admin shell](../theme/admin/index-local.html). Its verified
SRI is
`sha384-in6eHztHveqQ7uMZ1fDaKlDmacQLFuLH2wWrFTiymyuS8zQ5bixwL8U3AeRi8h/L`.
The platform comparison loads all 29 external script files from that same
shell, in its original order with its deferred flags. It excludes the shell's
inline branding/status scripts and CSS, and uses the same minimal configuration
as stock. Thus this isolates the platform script files, rather than claiming to
reproduce every consumer's full configuration. The comparison verifies that
`preview-pane.js` registered the Posts preview template and that no script
raised a page error. Preview visible/hidden uses Decap's own toggle and is checked
against the iframe's actual visibility in the regression.

## Native reproduction

The opt-in [native diagnostic](../e2e/decap-caret-native.js) uses Chromium
153.0.8010.12, a 1440 by 900 viewport, and a fresh browser page for each of the
eight comparisons. It places the initial caret at the Body's end, then alternates
actual mouse clicks at offset 2 in the first and second paragraphs, immediately
followed by `keyboard.type("XYZ")`. There is no delay between the click and
characters, no synthetic selection, and no modification of the stock bundle.
It compares each insertion with the text immediately before that insertion;
a prior split does not make all later trials count as wrong.

The 2026-10-07 run observed these character-placement mismatches:

| Scripts | Mode | Preview | Mismatches / native trials |
|---|---|---|---|
| Stock | Rich Text | Visible | 69 / 100 |
| Stock | Rich Text | Hidden | 44 / 100 |
| Stock | Markdown | Visible | 50 / 100 |
| Stock | Markdown | Hidden | 41 / 100 |
| Platform | Rich Text | Visible | 52 / 100 |
| Platform | Rich Text | Hidden | 2 / 100 |
| Platform | Markdown | Visible | 3 / 100 |
| Platform | Markdown | Hidden | 0 / 100 |

These are observations from one run, not a probability estimate or a CI oracle.
The zero-mismatch platform Markdown/hidden cell is inconclusive on its own; it
does not establish that those scripts fix the fault.
Browser event scheduling affects the counts. In Markdown mode the original
trailing newline can receive `YZ` as a new final line; the diagnostic counts
that as a misplaced insertion too.

An auxiliary 1440 by 1100 native stock Rich Text trace after an earlier
insertion had:

1. `click`, `keydown X`, and `beforeinput X`: Bravo paragraph, offset 2.
2. `keydown Y`: Alpha paragraph, offset 5, without another pointer action.
3. Result: `AlXYZYZpha paragraph has several words.` and
   `BrXavo paragraph also has several words.`

The expected second insertion was entirely in Bravo:
`BrXYZavo paragraph also has several words.` The first character reached the
clicked caret; the remaining two returned to the previous caret. The native
Body-end trial similarly puts `X` at the clicked first paragraph and `YZ` at the
previous Body end. The generated JSON records expected/actual text, native
selection events, Slate's read-only selection, and `beforeinput.getTargetRanges()`
for the first three mismatches in each cell.

## Responsible source boundary

Decap's release is
[commit bc76c05a80ab70d6b5c7cdaafc7d10cf56939c02](https://github.com/decaporg/decap-cms/tree/bc76c05a80ab70d6b5c7cdaafc7d10cf56939c02).
Both its
[VisualEditor](https://github.com/decaporg/decap-cms/blob/bc76c05a80ab70d6b5c7cdaafc7d10cf56939c02/packages/decap-cms-widget-markdown/src/MarkdownControl/VisualEditor.js)
and
[RawEditor](https://github.com/decaporg/decap-cms/blob/bc76c05a80ab70d6b5c7cdaafc7d10cf56939c02/packages/decap-cms-widget-markdown/src/MarkdownControl/RawEditor.js)
use Slate's `Editable`. The release lock resolves `slate-react` 0.117.4 with
`slate` and `slate-dom` 0.118.1.

The matching Slate source is
[`packages/slate-react/src/components/editable.tsx`](https://github.com/ianstormtaylor/slate/blob/7657838d4e6a522db92f9b71b44657297869ef53/packages/slate-react/src/components/editable.tsx).
Its
[throttled/debounced selection processing](https://github.com/ianstormtaylor/slate/blob/7657838d4e6a522db92f9b71b44657297869ef53/packages/slate-react/src/components/editable.tsx#L254-L340)
can leave a DOM caret newer than `editor.selection`. In
[the `beforeinput` target-range branch](https://github.com/ianstormtaylor/slate/blob/7657838d4e6a522db92f9b71b44657297869ef53/packages/slate-react/src/components/editable.tsx#L687-L709),
a different target range causes the old selection to be saved in
`EDITOR_TO_USER_SELECTION` and the target to be selected for insertion. At
[the end of that handler](https://github.com/ianstormtaylor/slate/blob/7657838d4e6a522db92f9b71b44657297869ef53/packages/slate-react/src/components/editable.tsx#L839-L846),
the saved selection is restored. Subsequent characters can then use that old
caret. This is an upstream selection-processing boundary, not preview rendering
in the platform's [preview pane](../theme/admin/preview-pane.js).

The previously cited
[upstream cursor issue #6867](https://github.com/decaporg/decap-cms/issues/6867)
closed on 2023-08-16 and described older versions. It is historical similarity,
not evidence that this specific current defect has already been acknowledged.

## Event-driven regression and control

[The dedicated configuration](../e2e/playwright.caret.config.js) matches only
the root diagnostic spec by its absolute path. Fixture placement copies the
harness into nested `e2e` directories; those copies must not become additional
cases. [The discovery regression](../e2e/decap-caret-diagnostic.test.js) runs
Playwright's test listing with both fixture copies present and requires exactly
eight root cases.

[The dedicated browser regression](../e2e/decap-caret-selection.spec.js) first
observes the actual Slate selection at Alpha offset 2 through a read-only React
fiber reference. It then temporarily prevents `selectionchange` listeners from
processing the caret click until the first `beforeinput` completes. It uses
trusted mouse and keyboard input throughout. This deliberately forces the
stale-model/fresh-DOM event ordering seen in the independent native run; it does
not claim that event suppression is a natural user action.

The trace asserts that `beforeinput X` has the Bravo offset-2 DOM target while
Slate still has Alpha offset 2, then `keydown Y` returns to Alpha offset 2.
The known defect produces `AlYZpha paragraph has several words.` and
`BrXavo paragraph also has several words.` The eight cases passed on three
consecutive repetitions (24 passed test executions, exit 0). This records a
known defect rather than using broad `test.fail()` to mask setup errors or
leaving the required lane red on every run. A fixed bundle changes the observed
split and requires reviewing the diagnostic.

The source control removes only the old-selection restoration call from the
verified bundle served to the diagnostic browser. It does not modify a runtime
platform file. Acorn and acorn-walk select that call structurally: a selection
call in an expression statement immediately following the conditional `unref()`
variable declaration, with that variable as its second argument. The selection
must match exactly one node, excluding the separate Android restoration path.
The original download is SRI-verified before the diagnostic-only transformation.
The control made all eight diagnostic tests fail (exit 1): `keydown Y` stayed
at Bravo offset 3 instead of returning to Alpha offset 2, and all of `XYZ`
remained at the clicked caret. Restoring the original verified bundle restored
the known split. This corroborates the restoration branch as the responsible
path for the reduced event ordering; it does not establish that removing it is
safe for all upstream editor operations.

## Running it locally and in CI

From `e2e/`, prepare the bundle once outside the tests, then run the browser
regression inside a PID namespace:

```bash
set -euo pipefail
mkdir -p node_modules/.cache/decap-caret/bin
cat > node_modules/.cache/decap-caret/bin/claude <<'STUB'
#!/bin/sh
printf 'called\n' >> "${CLAUDE_SENTINEL_LOG:?}"
exit 97
STUB
chmod +x node_modules/.cache/decap-caret/bin/claude
export PATH="$PWD/node_modules/.cache/decap-caret/bin:$PATH"
export CLAUDE_SENTINEL_LOG="$PWD/node_modules/.cache/decap-caret/claude-calls.log"

# Preparation needs network access; browser tests have no network fallback.
unshare --user --map-root-user --pid --fork --mount-proc -- \
  node prepare-decap-caret.js
test ! -s "$CLAUDE_SENTINEL_LOG"
unshare --user --map-root-user --net --pid --fork --mount-proc -- \
  npx playwright test --config=playwright.caret.config.js
test ! -s "$CLAUDE_SENTINEL_LOG"
```

Preparation reads the shell's exact version pin, validates the permitted URL,
verifies SHA-384 SRI, and caches the bundle under ignored `node_modules/.cache/`.
The tests read that cache without a network fallback. `DECAP_DIAGNOSTIC_BUNDLE`
can point to an already downloaded, matching bundle. Keep the sentinel PATH and
log environment above for the optional native diagnostic:

```bash
unshare --user --map-root-user --net --pid --fork --mount-proc -- \
  node decap-caret-native.js native-caret-evidence.json
test ! -s "$CLAUDE_SENTINEL_LOG"
```

The required [Self fixture E2E workflow](../.github/workflows/self-fixture-e2e.yml)
runs the preparation and dedicated offline regression on its Chromium admin
fixture-site leg. The normal consumer matrix excludes this platform-only spec.
The [integrity unit tests](../e2e/decap-caret-diagnostic.test.js) run in the
required Self CI `node-unit-lints` lane.

No delay shim, selection workaround, runtime bundle change, live publishing,
release, or consumer bump is included. Filing a new upstream issue and deciding
when to close the platform issue remain owner decisions; this package supplies
the evidence without making those external changes.
