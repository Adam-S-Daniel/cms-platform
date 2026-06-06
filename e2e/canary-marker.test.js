// @lane: local — PURE-fs/logic lint (no _site, no _e2e file reads): the
// in-flight-marker tolerance of the canary body byte-lock (#1815 host leg).
// Lives in its own file (not canary-content.test.js, which is build-dependent
// and DENY-listed from node-unit-lints) so this logic runs as a FAST PR gate.
const { test, expect } = require("./base");
const {
  stripInFlightMarker,
  makeMarker,
  buildBaselineBody,
  MARKER_SRC,
  MARKER_ANY_RE,
  MARKER_LINE_RE,
} = require("./canary-content");

test.describe("canary body byte-lock tolerates exactly one in-flight marker (#1815 host leg)", () => {
  const base = buildBaselineBody("Demo — E2E canary post (do not edit by hand).");
  const marker = makeMarker("post", 1780753215222);

  test("baseline with no marker is unchanged", () => {
    expect(stripInFlightMarker(base)).toBe(base);
  });
  test("a marker spliced mid-body (the editor End-key lands mid-line) is stripped", () => {
    // The spec types `\n\n${marker}\n` at end-of-LINE, so it lands wrapped.
    const mid = base.replace("innocuous content\n", `innocuous content\n\n${marker}\n\n`);
    expect(mid).not.toBe(base);
    expect(stripInFlightMarker(mid)).toBe(base);
  });
  test("a marker appended at the very end is stripped", () => {
    expect(stripInFlightMarker(`${base}\n\n${marker}`)).toBe(base);
  });
  test("TWO markers (multi-orphan pathology #1861) are NOT reduced to baseline → byte-lock fails loud", () => {
    const two = base.replace("innocuous content\n", `innocuous content\n\n${marker}\n\n`) + `\n\n${makeMarker("post", 999)}`;
    expect(stripInFlightMarker(two)).not.toBe(base);
  });
  test("genuine newline drift (the #882 doubling class) is NOT tolerated → byte-lock fails loud", () => {
    const drifted = base.replace("\n\n", "\n\n\n");
    expect(stripInFlightMarker(drifted)).not.toBe(base);
  });

  // EXHAUSTIVE: drive the publish-loop spec's ACTUAL insertion (press('End')
  // types `\n\n${marker}\n` at the end of whatever LINE the cursor is on) at
  // EVERY baseline line, both self-contained (no pre-trim) and pre-trimmed, so
  // a future change to buildBaselineBody()'s line count or the spec's typed
  // string is caught here. This is the gap the adversarial review flagged: the
  // earlier tests only covered one hand-built mid splice + one trailing append,
  // neither of which was the spec's real last-line trailing-\n shape.
  test("strips the spec's real insertion at every baseline line (self-contained + pre-trimmed)", () => {
    const lines = base.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const before = lines.slice(0, i + 1).join("\n");
      const after = lines.slice(i + 1).join("\n");
      // cursor at end of line i; the original newline before `after` remains.
      const injected = before + "\n\n" + marker + "\n" + (after ? "\n" + after : "");
      expect(stripInFlightMarker(injected), `self-contained strip at line ${i}`).toBe(base);
      const pretrimmed = injected.replace(/^\n+/, "").replace(/\n+$/, "");
      expect(stripInFlightMarker(pretrimmed), `pre-trimmed strip at line ${i}`).toBe(base);
    }
  });

  test("a dash-joined preview/spike marker id (preview-page, spike-project) is matched + stripped", () => {
    for (const id of ["preview-post", "preview-page", "spike-project"]) {
      const m = makeMarker(id, 1780753215222);
      expect(MARKER_LINE_RE.test(m), `${id}: marker line matches the shared pattern`).toBe(true);
      expect(stripInFlightMarker(`${base}\n\n${m}\n`), `${id}: stripped`).toBe(base);
    }
  });

  test("stripInFlightMarker is SELF-CONTAINED — it trims even without a caller pre-trim", () => {
    // A trailing-\n append (the spec's exact last-line shape) must strip WITHOUT
    // the caller having pre-trimmed (the adversarial 'not self-contained' hole).
    expect(stripInFlightMarker(`${base}\n\n${marker}\n`)).toBe(base);
    expect(stripInFlightMarker(`\n\n${base}\n\n${marker}\n\n`)).toBe(base);
  });

  test("the three marker checks share ONE pattern (byte-lock = afterAll = reset script)", () => {
    // canary-content.js is the single source; the spec's afterAll imports
    // MARKER_ANY_RE and reset-orphaned-canary.sh mirrors MARKER_SRC. Assert the
    // exported source string still matches the canonical marker shape so a drift
    // (the old [a-z]+ vs [a-z-]+ divergence) fails here.
    expect(new RegExp(`^${MARKER_SRC}$`).test(makeMarker("preview-page", 1))).toBe(true);
    expect(MARKER_ANY_RE.test("x e2e-publish-loop:post:123 y")).toBe(true);
    expect(MARKER_LINE_RE.test("e2e-publish-loop:-bad:1")).toBe(false); // no leading dash in id
  });
});
