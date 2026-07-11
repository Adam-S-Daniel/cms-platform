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
function bootShim(nativeReturn) {
  const nativeCalls = [];
  const appended = [];

  // The fake NATIVE window.confirm — records every delegated call and returns
  // the canned value, so a test can prove delegation + return-value passthrough.
  function nativeConfirm(msg) {
    nativeCalls.push(msg);
    return nativeReturn;
  }

  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    setTimeout: (fn) => fn, // don't auto-run the toast auto-remove
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
    },
  };
  sandbox.window.window = sandbox.window;

  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);

  return {
    sandbox,
    nativeCalls,
    appended,
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
