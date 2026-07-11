// @lane: local — pure-fs static invariant on the #161 confirm-wrap + autosave shim load order
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Static guard on the #161 local-backup-dialog + autosave shims' load order
// across ALL THREE admin shells (index.html / index-local.html /
// index-test.html), plus a source-level sanity check on the confirm-wrap.
//
// The two shims have OPPOSITE load-order requirements, both load-bearing:
//
//   - confirm-wrap-local-backup.js MUST be NON-deferred and load BEFORE
//     decap-cms.js — it captures + replaces window.confirm, and the wrap has
//     to be in place before Decap captures any reference to the original
//     (the exact publish-via-auto-merge.js idiom). If it were deferred / after
//     decap, Decap's misleading "restore local backup?" dialog would fire
//     against the un-wrapped native confirm and the fix would silently no-op.
//
//   - autosave-on-hide.js MUST be deferred and load AFTER decap-cms.js — it is
//     post-load behaviour that clicks the toolbar Save button Decap renders.
//
// Lexical HTML scanning is acceptable here (same precedent as
// admin-pin-invariant.test.js) — we assert on literal <script> tags and their
// order, not on code structure.

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN_DIR = path.join(REPO_ROOT, "theme", "admin");

const CONFIRM_WRAP = "confirm-wrap-local-backup.js";
const AUTOSAVE = "autosave-on-hide.js";
// The exact English confirmLoadBackup string Decap passes to window.confirm
// (verified byte-identical in the decap-cms 3.12.2 + 3.14.1 bundles). If this
// ever drifts from the shim's literal, the wrap stops matching → the dialog
// returns.
const BACKUP_STRING = "A local backup was recovered for this entry, would you like to use it?";

function adminHtmlFiles() {
  return fs
    .readdirSync(ADMIN_DIR)
    .filter((f) => /^index.*\.html$/.test(f))
    .map((f) => path.join(ADMIN_DIR, f));
}

// The <script src="..."> tag (self-closing) for a given basename, returning
// { index, defer } or null when absent. `index` is the byte offset of the tag.
function scriptTag(html, basename) {
  const re = new RegExp(
    `<script\\s+src="${basename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"([^>]*)>\\s*</script>`,
  );
  const m = re.exec(html);
  if (!m) return null;
  return { index: m.index, defer: /\bdefer\b/.test(m[1]) };
}

function decapIndex(html) {
  const m = /<script\s+src="https:\/\/unpkg\.com\/decap-cms@[^"']+"[^>]*>/.exec(html);
  return m ? m.index : -1;
}

test.describe("admin shells: #161 confirm-wrap + autosave load order", () => {
  for (const file of adminHtmlFiles()) {
    const label = path.relative(REPO_ROOT, file);

    test(`${label}: confirm-wrap non-deferred BEFORE decap, autosave deferred AFTER`, () => {
      const html = fs.readFileSync(file, "utf8");
      const decap = decapIndex(html);
      expect(decap, `${label} should load the decap-cms bundle`).toBeGreaterThan(-1);

      const confirm = scriptTag(html, CONFIRM_WRAP);
      expect(confirm, `${label} must load ${CONFIRM_WRAP}`).not.toBeNull();
      expect(
        confirm.defer,
        `${label}: ${CONFIRM_WRAP} must NOT be deferred — it wraps window.confirm before Decap captures it`,
      ).toBe(false);
      expect(
        confirm.index,
        `${label}: ${CONFIRM_WRAP} must load BEFORE decap-cms.js`,
      ).toBeLessThan(decap);

      const autosave = scriptTag(html, AUTOSAVE);
      expect(autosave, `${label} must load ${AUTOSAVE}`).not.toBeNull();
      expect(
        autosave.defer,
        `${label}: ${AUTOSAVE} must be deferred (post-load behaviour)`,
      ).toBe(true);
      expect(
        autosave.index,
        `${label}: ${AUTOSAVE} must load AFTER decap-cms.js`,
      ).toBeGreaterThan(decap);
    });
  }

  test("confirm-wrap-local-backup.js captures + reassigns window.confirm for the exact backup string", () => {
    const src = fs.readFileSync(path.join(ADMIN_DIR, CONFIRM_WRAP), "utf8");
    // Captures the ORIGINAL native confirm (so non-backup messages delegate).
    expect(
      /var\s+origConfirm\s*=\s*window\.confirm\.bind\(window\)/.test(src),
      `${CONFIRM_WRAP} must capture the original window.confirm (origConfirm = window.confirm.bind(window))`,
    ).toBe(true);
    // Reassigns window.confirm with the wrapper.
    expect(
      /window\.confirm\s*=\s*function/.test(src),
      `${CONFIRM_WRAP} must reassign window.confirm with a wrapper function`,
    ).toBe(true);
    // Matches the EXACT English confirmLoadBackup string.
    expect(
      src.includes(JSON.stringify(BACKUP_STRING)),
      `${CONFIRM_WRAP} must match the exact confirmLoadBackup string ${JSON.stringify(BACKUP_STRING)}`,
    ).toBe(true);
    // Idempotency flag (matches the publish-via-auto-merge.js install idiom).
    expect(
      src.includes("window.__confirmWrapLocalBackupInstalled"),
      `${CONFIRM_WRAP} must guard against double-install via window.__confirmWrapLocalBackupInstalled`,
    ).toBe(true);
  });
});
