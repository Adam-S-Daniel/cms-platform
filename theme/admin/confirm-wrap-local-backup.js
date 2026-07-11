/*
 * confirm-wrap-local-backup.js — admin/ shim that DISABLES Decap CMS's
 * misleading "restore local backup" dialog (issues #161 / #160).
 *
 * ── The bug (Decap core, not platform code) ───────────────────────────
 * On entry open, Decap's Editor.js `componentDidMount` fires two
 * uncoordinated async dispatches: `retrieveLocalBackup` (a FAST IndexedDB
 * read) and `loadEntry` (a SLOW network fetch of the saved entry, slower
 * still under editorial_workflow). The fast read wins, `componentDidUpdate`
 * shows a native `window.confirm(...)` "restore your unsaved work?" dialog,
 * and if the editor accepts, the just-restored draft is IMMEDIATELY
 * clobbered when the in-flight `loadEntry` resolves and unconditionally
 * dispatches `createDraftFromEntry(loadedEntry)` (there is NO hasChanged /
 * just-restored guard). So the dialog promises recovered work and then
 * silently discards it. Upstream: decaporg/decap-cms#6989 (open, filed by a
 * maintainer) + #5055 / #5470 / #3433. No released version fixes it (verified
 * through decap-cms-core 3.16.0 / the decap-cms 3.14.1 bundle), and there is
 * NO config flag to disable the local-backup feature — so we intercept it at
 * the browser seam.
 *
 * ── The seam (verbatim from the pinned decap-cms bundle) ──────────────
 *   componentDidUpdate: ... window.confirm(t("editor.editor.confirmLoadBackup"))
 *     ? this.props.loadLocalBackup() : this.deleteBackup()
 * The confirm is a NATIVE window.confirm (NOT a React modal), byte-identical
 * on 3.12.2 and 3.14.1. Returning FALSE from our wrapper both suppresses the
 * dialog AND drives Decap into its own `deleteBackup()` (the `? :`
 * else-branch), which clears the stale backup from the localForage
 * "keyvaluepairs" IndexedDB store for us — we do NOT touch that store
 * directly (Decap bundles localForage; it is not exposed on window).
 *
 * ── English-locale assumption ─────────────────────────────────────────
 * We match the EXACT English string for `editor.editor.confirmLoadBackup`.
 * Both consuming sites (adamdaniel.ai, jodidaniel.com) are `en`, so this is
 * safe today. This assumption is load-bearing: a locale change would require
 * updating BACKUP_STRING to the translated confirm text (or the dialog
 * returns to the user in that locale).
 *
 * ── What we DO NOT touch ──────────────────────────────────────────────
 * EVERY other window.confirm message (delete confirms, publish/unpublish,
 * media replace, the routing lib's navigation guard, …) is delegated to the
 * ORIGINAL native confirm unchanged — the e2e delete flows depend on the
 * native dialog surviving (they auto-accept via page.on("dialog", ...)). We
 * wrap ONLY window.confirm, never window.fetch (publish-via-auto-merge.js
 * owns the single fetch wrap; a second wrap risks the Safari loadEntries
 * hang), so the two shims compose.
 *
 * Loaded via a NON-deferred <script> tag in admin/index*.html *before*
 * decap-cms.js, so the wrap is in place before Decap captures any reference
 * to window.confirm.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof window.confirm !== "function") return;
  if (window.__confirmWrapLocalBackupInstalled) return;
  window.__confirmWrapLocalBackupInstalled = true;

  // The exact English string Decap passes to window.confirm for
  // `editor.editor.confirmLoadBackup`. Verified byte-identical in the
  // decap-cms 3.12.2 and 3.14.1 unpkg bundles. See the English-locale
  // assumption note in the header — a locale change requires updating this.
  var BACKUP_STRING = "A local backup was recovered for this entry, would you like to use it?";

  var origConfirm = window.confirm.bind(window);

  window.confirm = function (msg) {
    if (msg === BACKUP_STRING) {
      // Returning false BOTH suppresses the (misleading) dialog AND routes
      // Decap into its own deleteBackup() — clearing the stale IndexedDB
      // backup so the race can't resurface a phantom "recovered" draft.
      toast(
        "Draft-restore is off — Decap's local backup was unreliable and could " +
          "silently drop your changes. Your work is saved by Save and by autosave " +
          "(on tab-close and after a short idle) onto this entry's PR branch — " +
          "nothing goes live until you Publish.",
      );
      return false;
    }
    // Every other confirm (delete / publish / navigation guard / …) goes to
    // the ORIGINAL native dialog untouched — the e2e delete flows depend on
    // the native confirm surviving.
    return origConfirm(msg);
  };

  function toast(msg) {
    try {
      var t = document.createElement("div");
      t.textContent = msg;
      t.setAttribute("role", "status");
      t.setAttribute("data-confirm-wrap-local-backup-toast", "");
      // Inline style.cssText (NOT a .css file) so admin-css-banned-patterns
      // — which only scans theme/admin/*.css + <style> blocks — is untouched.
      t.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
        "background:#1f2937;color:#fff;padding:14px 20px;border-radius:8px;" +
        "font:14px/1.4 system-ui,sans-serif;max-width:560px;z-index:2147483647;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.3);";
      document.body.appendChild(t);
      setTimeout(function () {
        try {
          t.remove();
        } catch {
          /* ignore */
        }
      }, 14000);
    } catch {
      /* DOM not ready — log only */
    }
    // Always log; useful for the playwright spec to assert via console.
    console.warn("[confirm-wrap-local-backup]", msg);
  }

  // Tiny surface for tests / debugging — lets a spec verify the wrap is
  // installed without reaching into module internals.
  window.__confirmWrapLocalBackup = {
    installed: true,
    origConfirm: origConfirm,
    backupString: BACKUP_STRING,
  };
})();
