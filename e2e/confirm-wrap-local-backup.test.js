// @lane: local — pure-Node sandbox unit tests for the confirm-wrap-local-backup shim
/*
 * Unit tests for admin/confirm-wrap-local-backup.js (#161). Pure-Node, no
 * browser: we load the shim source as a string, run it inside a minimal
 * sandbox that fakes `window`, `document`, and the NATIVE `window.confirm`,
 * then drive the wrapped confirm and assert:
 *
 *   - the exact backup-restore prompt returns false WITHOUT calling the
 *     native confirm (so no dialog shows), and appends an unobtrusive toast;
 *   - EVERY other message delegates to the captured original native confirm
 *     and returns its value unchanged (delete confirms etc. must survive —
 *     the e2e delete flows depend on the native dialog);
 *   - the install is idempotent.
 *
 * Mirrors the vm-sandbox pattern in publish-via-auto-merge.test.js.
 *
 * The browser-driving coverage (the toast rendering in a real DOM, and the
 * autosave Save-click DOM coupling) lives in e2e/cms-autosave.spec.js.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM_PATH = path.resolve(__dirname, "../theme/admin/confirm-wrap-local-backup.js");
const SHIM_SOURCE = fs.readFileSync(SHIM_PATH, "utf8");

const BACKUP_STRING = "A local backup was recovered for this entry, would you like to use it?";

/**
 * Boot a fresh sandbox + load the shim into it.
 * @param {*} nativeReturn value the fake NATIVE confirm returns for delegated messages.
 */
function bootShim(nativeReturn, hostname) {
  const nativeCalls = [];
  const appended = [];
  const timers = [];

  // The fake NATIVE window.confirm — records every delegated call and returns
  // the canned value, so a test can prove delegation + return-value passthrough.
  function nativeConfirm(msg) {
    nativeCalls.push(msg);
    return nativeReturn;
  }

  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout: (fn, ms) => {
      timers.push(ms); // recorded, never run: don't auto-remove the toast
      return fn;
    },
    document: {
      createElement: () => ({
        textContent: "",
        setAttribute: () => {},
        style: { cssText: "" },
        remove: () => {},
      }),
      body: {
        appendChild: (node) => {
          appended.push(node);
        },
      },
    },
    window: {
      confirm: nativeConfirm,
      CMSHostname: hostname,
    },
  };
  sandbox.window.window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);

  return {
    sandbox,
    nativeCalls,
    appended,
    timers,
    // The (now-wrapped) confirm.
    confirm: (msg) => sandbox.window.confirm(msg),
  };
}

test.describe("confirm-wrap-local-backup.js (unit)", () => {
  test("installs by setting window.__confirmWrapLocalBackupInstalled + a test surface", () => {
    const { sandbox } = bootShim(true);
    expect(sandbox.window.__confirmWrapLocalBackupInstalled).toBe(true);
    expect(sandbox.window.__confirmWrapLocalBackup.installed).toBe(true);
    expect(sandbox.window.__confirmWrapLocalBackup.backupString).toBe(BACKUP_STRING);
  });

  test("the backup-restore prompt returns false WITHOUT calling native confirm, and appends a toast", () => {
    const { confirm, nativeCalls, appended } = bootShim(true);
    const result = confirm(BACKUP_STRING);
    // Returning false suppresses the dialog AND drives Decap's deleteBackup().
    expect(result).toBe(false);
    // The native confirm must NOT have been invoked (no dialog shown).
    expect(nativeCalls).toHaveLength(0);
    // An unobtrusive toast (role=status) was appended.
    expect(appended).toHaveLength(1);
  });

  test("any OTHER message delegates to the captured original confirm and returns ITS value (true)", () => {
    const { confirm, nativeCalls, appended } = bootShim(true);
    const result = confirm("Are you sure you want to delete this published entry?");
    expect(result).toBe(true); // native's return value, passed through
    expect(nativeCalls).toEqual(["Are you sure you want to delete this published entry?"]);
    // No toast for a delegated message.
    expect(appended).toHaveLength(0);
  });

  test("any OTHER message delegates and returns ITS value (false)", () => {
    const { confirm, nativeCalls } = bootShim(false);
    const result = confirm("Are you sure you want to publish this entry?");
    expect(result).toBe(false); // native said no → wrapper returns false
    expect(nativeCalls).toEqual(["Are you sure you want to publish this entry?"]);
  });

  test("re-invocation is a no-op (idempotent install)", () => {
    const ctx = bootShim(true);
    const confirmAfterFirst = ctx.sandbox.window.confirm;
    vm.runInContext(SHIM_SOURCE, ctx.sandbox);
    // The second run must NOT re-wrap (else origConfirm would become the
    // first wrapper and the backup string could double-toast).
    expect(ctx.sandbox.window.confirm).toBe(confirmAfterFirst);
  });
});

// #625 item 4: the reload toast is read by the site's non-technical owner. It
// must not use developer vocabulary or sound like something is broken, and it
// must not sit over the form for long.
test("the reload toast is written in owner language and is short-lived", () => {
  const ctx = bootShim(true);
  ctx.confirm(BACKUP_STRING);
  const toast = ctx.appended[ctx.appended.length - 1];
  const timers = ctx.timers;
  expect(toast).not.toBeNull();
  const text = toast.textContent;
  for (const banned of [/draft-restore/i, /decap/i, /local backup/i, /PR branch/i, /autosave/i, /unreliable/i, /is off/i]) {
    expect(text, String(banned)).not.toMatch(banned);
  }
  expect(text).toContain("Your work is saved automatically when you pause or close the tab, and when you press Save.");
  expect(text).toMatch(/Nothing reaches .* until you press Publish./);
  // Short enough not to cover fields for long (was 14 s).
  expect(Math.max(...timers)).toBeLessThanOrEqual(8000);
  // Pinned to a corner, not centred over the form.
  expect(toast.style.cssText).not.toContain("translateX(-50%)");
});

for (const [access, destination] of [
  ["preview-pr42.example.com", "example.com"],
  ["example.com", "preview-pr42.example.com"],
  ["example.com", "example.com"],
  ["preview-pr42.example.com", "preview-pr42.example.com"],
]) {
  test(`backup toast names ${destination} when opened on ${access} (#533)`, () => {
    const { confirm, appended } = bootShim(true, {
      current: () => access,
      destination: () => destination,
    });
    expect(confirm(BACKUP_STRING)).toBe(false);
    expect(appended).toHaveLength(1);
    expect(appended[0].textContent).toContain(`Nothing reaches ${destination} until you press Publish.`);
  });
}

// #733: cancelling Decap's leave prompt on a browser Back must leave the URL on
// the entry. Decap's hash router restores it with `history.go(delta)` only when
// it pushed the entry itself; the Posts list rows are plain anchors, so for them
// nothing restores it and the address bar stays on the list while the editor
// stays on screen (and ← becomes a no-op). The shim sets the hash back, but only
// when the confirm was cancelled inside that hashchange AND Decap did not call
// `history.go` itself.
const LEAVE_STRING = "Are you sure you want to leave this page?";
const ORIGIN = "http://localhost:4000/admin/index.html";
const ENTRY = "#/collections/posts/entries/2026-10-05-a-post";
const LIST = "#/collections/posts";

/**
 * A sandbox with a scriptable router: `window.history.go`, a `location` whose
 * hash can be moved, `addEventListener`, and a setTimeout the test flushes.
 * `decap(ev)` plays Decap's own hashchange listener, which loads AFTER the shim.
 */
function bootRouter({ answer, decap, canWrapGo = true }) {
  const timers = [];
  const goCalls = [];
  const hashWrites = [];
  const listeners = [];
  const history = {};
  const nativeGo = (n) => {
    goCalls.push(n);
  };
  if (canWrapGo) history.go = nativeGo;
  else Object.defineProperty(history, "go", { value: nativeGo, writable: false });
  let hash = ENTRY;
  const location = {
    get href() {
      return ORIGIN + hash;
    },
    get hash() {
      return hash;
    },
    set hash(next) {
      hashWrites.push(next);
      hash = next;
    },
  };
  const sandbox = {
    console: { warn() {}, error() {}, log() {} },
    setTimeout: (fn) => timers.push(fn),
    document: { createElement: () => ({ style: {}, setAttribute() {}, remove() {} }), body: { appendChild() {} } },
    window: {
      confirm: () => answer,
      addEventListener: (type, fn) => type === "hashchange" && listeners.push(fn),
      history,
      location,
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);

  return {
    hashWrites,
    goCalls,
    confirm: (msg) => sandbox.window.confirm(msg),
    /** The browser moves the hash, then every hashchange listener runs, in order. */
    backTo(to) {
      const from = hash;
      hash = to;
      const ev = { oldURL: ORIGIN + from, newURL: ORIGIN + to };
      for (const fn of listeners) fn(ev);
      if (decap) decap(ev, sandbox.window);
    },
    flush() {
      while (timers.length) timers.shift()();
    },
  };
}

test.describe("leave prompt cancelled on browser Back (#733)", () => {
  test("Cancel with no revert from Decap: the hash is set back to the entry", () => {
    const r = bootRouter({ answer: false, decap: (ev, w) => w.confirm(LEAVE_STRING) });
    r.backTo(LIST);
    expect(r.hashWrites).toEqual([]); // nothing happens inside the dispatch
    r.flush();
    expect(r.hashWrites).toEqual([ENTRY]);
  });

  test("Cancel when Decap reverts itself with history.go: the shim stays out", () => {
    const r = bootRouter({
      answer: false,
      decap: (ev, w) => {
        w.confirm(LEAVE_STRING);
        w.history.go(1);
      },
    });
    r.backTo(LIST);
    r.flush();
    expect(r.goCalls).toEqual([1]); // the wrapped go still reaches the real one
    expect(r.hashWrites).toEqual([]);
  });

  test("Accepting the prompt does not touch the hash", () => {
    const r = bootRouter({ answer: true, decap: (ev, w) => w.confirm(LEAVE_STRING) });
    r.backTo(LIST);
    r.flush();
    expect(r.hashWrites).toEqual([]);
  });

  test("Another cancelled confirm during a hashchange does not touch the hash", () => {
    const r = bootRouter({ answer: false, decap: (ev, w) => w.confirm("Are you sure you want to delete this entry?") });
    r.backTo(LIST);
    r.flush();
    expect(r.hashWrites).toEqual([]);
  });

  test("A cancelled leave confirm outside a hashchange (the ← link, a push) does not touch the hash", () => {
    const r = bootRouter({ answer: false });
    r.backTo(LIST); // a hashchange came and went; the dispatch is over once flushed
    r.flush();
    expect(r.confirm(LEAVE_STRING)).toBe(false);
    r.flush();
    expect(r.hashWrites).toEqual([]);
  });

  test("the hash is left alone when something else already moved it", () => {
    const r = bootRouter({
      answer: false,
      decap: (ev, w) => {
        w.confirm(LEAVE_STRING);
        w.location.hash = "#/collections/pages";
      },
    });
    r.backTo(LIST);
    r.hashWrites.length = 0;
    r.flush();
    expect(r.hashWrites).toEqual([]);
  });

  test("a history whose go cannot be wrapped is never second-guessed", () => {
    const r = bootRouter({ answer: false, canWrapGo: false, decap: (ev, w) => w.confirm(LEAVE_STRING) });
    r.backTo(LIST);
    r.flush();
    expect(r.hashWrites).toEqual([]);
  });
});
