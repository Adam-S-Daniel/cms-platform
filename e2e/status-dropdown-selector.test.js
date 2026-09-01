// @lane: local — PURE-FS code-shape lint (NO Jekyll build, NO browser).
//
// #382 — NO SPEC MAY SELECT DECAP'S STATUS DROPDOWN BY NAME.
//
// ── The incident ───────────────────────────────────────────────────────
// v0.1.96 shipped the one-door publish model (docs/PUBLISHING-UX.md):
// `theme/admin/one-door-publish.js` CSS-hides Decap's `Status: Draft`
// dropdown on the PRODUCTION shell (`theme/admin/index.html`), and
// `publish-button.js` replaces Decap's split Publish control with
// `#cms-publish-button` plus an inline "Yes, publish".
//
// `getByRole` SKIPS CSS-hidden elements. So every spec still doing
//
//     page.getByRole("button", { name: /^Status:\s*Draft$/i }).click()
//
// against the production `/admin/` shell stopped resolving anything and
// timed out — silently, an hour into a real prod-mutating run.
// adamdaniel.ai's scheduled `cms-publish-loop-host` failed on it daily
// (run 33528263986) across four specs at once: cms-delete-published,
// cms-tags-lifecycle, cms-publish-loop and cms-preview-pr-self-contained.
// v0.1.97 had already made `publishViaUi()` shell-aware; what was missing
// was anything that noticed the four specs were not calling it.
//
// ── Why a lint, and why an AST one ─────────────────────────────────────
// The failure mode is invisible to every pure-fs lane (the selector is
// perfectly valid code) and costs a >1h prod loop to observe. It is also
// the exact class the house rule names: a check that reasons about which
// CONTROL a call selects is reasoning about code shape, so it parses a
// real AST (e2e/spec-ast.js → acorn) and never regex-scans the source.
// A regex here would be wrong twice over — this very file quotes the
// banned selector in its own header comment, and several specs discuss
// "Status:" in prose that must stay legal.
//
// ── The one permitted home ─────────────────────────────────────────────
// e2e/cms-editor-ui.js's `publishViaUi()` keeps the Decap branch for the
// shells that still ship Decap's own controls — `index-test.html` (the
// rehearsal surface, deliberately unshimmed) and `index-local.html` (no
// editorial workflow at all). That file is a HELPER, not a `*.spec.js`,
// so it falls outside this lint's scope naturally rather than by
// exception. The last assertion below pins it there, so the detector can
// never quietly become a no-op that passes over an empty world.
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { analyzeSpec } = require("./spec-ast");

const E2E_DIR = __dirname;

// Specs that legitimately drive Decap's OWN Status dropdown, i.e. ones that
// run against `index-test.html`, where nothing is hidden. Basename → reason.
//
// EMPTY, and measured so: no spec in the tree selects that control by role +
// name today. cms-workflow-states.spec.js — the one spec that genuinely
// exercises Decap's editorial states on the rehearsal shell — reads the
// status with `getByText`, not `getByRole`, so it is out of scope without
// needing an entry here. Add one only for a spec that both targets
// index-test.html AND selects the control by role, and say which.
const ALLOWED = {};

// A regex literal's SOURCE spells whitespace as `\s*` / `\s+` / `\s`, and a
// string name may carry a plain space. Fold both to nothing so `Status:` and
// `Status\s*:` are recognised as the same control, then match the label.
function namesStatusControl(nameText) {
  const folded = String(nameText).replace(/\\s[*+?]?/g, "");
  return /status\s*:/i.test(folded);
}

// Every getByRole(..., { name }) in `src` whose name designates the Status
// control, as readable strings for the failure message.
function statusSelectors(src) {
  return analyzeSpec(src)
    .getByRoleNames.filter((r) => namesStatusControl(r.name))
    .map((r) => `getByRole(${JSON.stringify(r.role)}, { name: ${r.name} })`);
}

const SPEC_FILES = fs
  .readdirSync(E2E_DIR)
  .filter((f) => f.endsWith(".spec.js"))
  .sort();

test.describe("#382 no spec selects Decap's hidden Status dropdown", () => {
  test("the spec set is non-empty (the lint has something to police)", () => {
    expect(SPEC_FILES.length, "e2e/*.spec.js files found").toBeGreaterThan(0);
  });

  for (const file of SPEC_FILES) {
    test(`${file} :: does not getByRole the Status dropdown`, () => {
      const src = fs.readFileSync(path.join(E2E_DIR, file), "utf8");
      const hits = statusSelectors(src);
      if (ALLOWED[file]) {
        // Allowlisted: the entry must be earning its keep, or it is stale.
        expect(
          hits.length,
          `${file} is allowlisted (${ALLOWED[file]}) but no longer selects the Status ` +
            `control — delete its ALLOWED entry`,
        ).toBeGreaterThan(0);
        return;
      }
      expect(
        hits,
        `${file} selects Decap's Status dropdown by role+name. That control is CSS-hidden ` +
          `by one-door-publish.js on the production /admin/ shell, so getByRole skips it and ` +
          `the click times out mid-run (#382). Publish with publishViaUi(page) from ` +
          `./cms-editor-ui — it is shell-aware and keeps the Decap path for index-test.html.`,
      ).toEqual([]);
    });
  }

  // NEGATIVE CONTROL. Without this, deleting the last real selector would
  // leave a green lint that can no longer detect anything, and nobody would
  // know. cms-editor-ui.js is not a *.spec.js, so it is out of the loop
  // above — but it IS where the Decap-shell branch legitimately lives, which
  // makes it the natural fixture proving the detector still fires.
  test("the detector still fires — publishViaUi's Decap branch is found", () => {
    const helper = fs.readFileSync(path.join(E2E_DIR, "cms-editor-ui.js"), "utf8");
    expect(
      statusSelectors(helper).length,
      "cms-editor-ui.js should still carry the Decap-shell Status→Ready selector; if that " +
        "branch was deliberately removed, this lint needs a new fixture or it is a no-op",
    ).toBeGreaterThan(0);
  });
});
