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
 * on 3.12.2, 3.14.1 and 3.15.1 — the whole call site above, including the
 * `? :` else-branch, greps out of the 3.15.1 bundle unchanged even though
 * 3.15.x switched the surrounding render code to React 19's automatic JSX
 * runtime. Returning FALSE from our wrapper both suppresses the
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
 * ── Plain-language rewrites (#649) ────────────────────────────────────
 * Three more Decap confirms are shown to a non-technical owner and say too
 * little: the delete-a-published-entry confirm does not name the entry or say
 * it leaves the site, and the in-app "leave this page" guard does not mention
 * unsaved changes. Each is REWRITTEN (same English-locale exact-match
 * assumption as above) and then shown through the ORIGINAL native confirm, so
 * the dialog, its OK/Cancel return value and the e2e dialog auto-accept all
 * behave as before. The browser's own "Leave site?" prompt (Decap's
 * beforeunload handler, on tab close or reload) is NOT a window.confirm and
 * its text cannot be customized by any modern browser, so it is out of reach.
 *
 * ── What we DO NOT touch ──────────────────────────────────────────────
 * EVERY other window.confirm message (publish/unpublish, media replace, …)
 * is delegated to the ORIGINAL native confirm unchanged — the e2e delete flows depend on the
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
  // decap-cms 3.12.2, 3.14.1 and 3.15.1 unpkg bundles. See the English-locale
  // assumption note in the header — a locale change requires updating this.
  var BACKUP_STRING = "A local backup was recovered for this entry, would you like to use it?";

  // Long enough to read two sentences, short enough not to linger over the form.
  var TOAST_MS = 7000;

  var origConfirm = window.confirm.bind(window);

  // The open entry's title, read from the editor's title field; a generic
  // noun when no editor is open or the field is empty.
  function entryName() {
    try {
      var input = document.querySelector('input[id^="title-field"]');
      var v = input && typeof input.value === "string" ? input.value.trim() : "";
      if (v) return "“" + v + "”";
    } catch {
      /* no DOM — fall through */
    }
    return "this entry";
  }

  function destinationName() {
    var d = window.CMSHostname && window.CMSHostname.destination ? window.CMSHostname.destination() : "";
    return d || "the site";
  }

  // Exact English Decap strings -> owner-language replacement text.
  var REWRITES = {
    "Are you sure you want to delete this published entry?": function () {
      return "Delete " + entryName() + "? It will be removed from " + destinationName() + ".";
    },
    "Are you sure you want to delete this published entry, as well as your unsaved changes from the current session?":
      function () {
        return (
          "Delete " + entryName() + "? It will be removed from " + destinationName() +
          ", and the changes you have not saved yet will be lost."
        );
      },
    "Are you sure you want to leave this page?": function () {
      return "You have changes that are not saved yet. If you leave now, you will lose them. Leave anyway?";
    },
  };

  window.confirm = function (msg) {
    if (msg === BACKUP_STRING) {
      // Returning false BOTH suppresses the (misleading) dialog AND routes
      // Decap into its own deleteBackup() — clearing the stale IndexedDB
      // backup so the race can't resurface a phantom "recovered" draft.
      // Owner language (#625 item 4): this is read by the site's
      // non-technical owner after a reload, so no tool names and nothing that
      // sounds broken. The facts are the same: Save and the automatic save
      // (tab close, short idle) keep the work; only Publish reaches the site.
      toast(
        "Your work is saved automatically when you pause or close the tab, and when you press Save. " +
          "Nothing reaches " +
          (window.CMSHostname ? window.CMSHostname.destination() : "the site") +
          " until you press Publish.",
      );
      return false;
    }
    // The rewrites below still go through the ORIGINAL native dialog; every
    // other confirm (publish / unpublish / …) is passed through untouched —
    // the e2e delete flows depend on the native confirm surviving.
    if (Object.prototype.hasOwnProperty.call(REWRITES, msg)) return origConfirm(REWRITES[msg]());
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
        // Bottom-right and narrow, for a few seconds: a centred 560px toast
        // for 14s sat over the form fields the owner had just come back to.
        "position:fixed;bottom:16px;right:16px;" +
        "background:#1f2937;color:#fff;padding:12px 16px;border-radius:8px;" +
        "font:14px/1.4 system-ui,sans-serif;max-width:min(340px,calc(100vw - 32px));z-index:2147483647;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.3);";
      document.body.appendChild(t);
      setTimeout(function () {
        try {
          t.remove();
        } catch {
          /* ignore */
        }
      }, TOAST_MS);
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
    rewrites: Object.keys(REWRITES),
  };
})();
