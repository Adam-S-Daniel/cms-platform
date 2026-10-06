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
 * ── What we DO NOT touch ──────────────────────────────────────────────
 * EVERY other window.confirm message (delete confirms, publish/unpublish,
 * media replace, the routing lib's navigation guard, …) is delegated to the
 * ORIGINAL native confirm unchanged — the e2e delete flows depend on the
 * native dialog surviving (they auto-accept via page.on("dialog", ...)). We
 * wrap ONLY window.confirm, never window.fetch (publish-via-auto-merge.js
 * owns the single fetch wrap; a second wrap risks the Safari loadEntries
 * hang), so the two shims compose.
 *
 * ── Second job: put the URL back when the leave prompt is cancelled (#733)
 * Decap's editor blocks navigation while the draft has unsaved changes. On a
 * browser Back it asks window.confirm("Are you sure you want to leave this
 * page?"); a "Cancel" is supposed to leave the editor exactly where it was.
 * It cannot, in the common case: Decap's hash router (history v4) restores
 * the old hash by `history.go(delta)`, with `delta` read from a private list
 * of the locations IT pushed. Decap 3.15.x renders the Posts list rows as
 * plain `<a href="#/…">` anchors, so opening an entry (or reloading on one)
 * never enters that list, `delta` comes out 0, and nothing is restored: the
 * address bar says `#/collections/posts` while the editor stays on screen, and
 * the editor's own ← (a push to the hash it is already at) does nothing until
 * a reload. Upstream limitation; there is no config seam.
 *
 * The repair is tiny and composes with Decap's own revert: this shim sees the
 * `hashchange` first (it loads first), notes the hash we left, and — only when
 * the leave confirm was answered "Cancel" inside that very hashchange AND
 * Decap did not call `history.go` itself (so its revert did not run) — sets
 * the hash back once the dispatch is over. Decap's listener then finds the
 * address already equal to the route it still believes it is on and ignores
 * it. Accepted prompts, ← and Link pushes, and every other confirm are
 * untouched. Like the backup string above it matches Decap's English
 * `editor.editor.onLeavePage` text; on a translated admin it is a no-op.
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

  // Decap's `editor.editor.onLeavePage`, English (see "Second job" above).
  var LEAVE_STRING = "Are you sure you want to leave this page?";

  var origConfirm = window.confirm.bind(window);

  // The hashchange being dispatched right now, if any (#733). Cleared by a
  // zero-delay timer, i.e. once every listener — Decap's included — has run.
  var inPop = null;
  // True once `history.go` is wrapped, i.e. Decap's own revert is observable.
  var canSeeRevert = false;

  function fragmentOf(url) {
    var s = String(url || "");
    var i = s.indexOf("#");
    return i < 0 ? "" : s.slice(i);
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("hashchange", function (ev) {
      var pop = { from: fragmentOf(ev && ev.oldURL), to: fragmentOf(ev && ev.newURL), cancelled: false, reverted: false };
      inPop = pop;
      setTimeout(function () {
        if (inPop === pop) inPop = null;
        if (!canSeeRevert || !pop.cancelled || pop.reverted || !pop.from) return;
        // Decap kept the editor but did not (or could not) restore the hash.
        if (window.location && fragmentOf(window.location.href) === pop.to) window.location.hash = pop.from;
      }, 0);
    });
  }

  // Decap reverts a cancelled POP with `history.go(delta)` from inside the
  // same hashchange dispatch; seeing that call means it is handling the
  // restore itself and we must stay out of the way.
  var hist = window.history;
  if (hist && typeof hist.go === "function") {
    var origGo = hist.go;
    try {
      hist.go = function () {
        if (inPop) inPop.reverted = true;
        return origGo.apply(this, arguments);
      };
      canSeeRevert = true;
    } catch {
      /* read-only history: Decap's revert cannot be seen, so never second-guess it */
    }
  }

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
    // Every other confirm (delete / publish / navigation guard / …) goes to
    // the ORIGINAL native dialog untouched — the e2e delete flows depend on
    // the native confirm surviving.
    var answer = origConfirm(msg);
    if (!answer && msg === LEAVE_STRING && inPop) inPop.cancelled = true;
    return answer;
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
  };
})();
