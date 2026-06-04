// @lane: local — pure-logic unit tests for the bump-aware admin-bundle parity
// decision (fix #14). NO network, NO browser: drives admin-bundle-parity.js's
// pure verdict functions with fixture bundle bytes. Runs in self-ci's
// node-unit-lints lane.
//
// The probe (admin-bundle-parity.spec.js) byte-compares the SERVED admin bundle
// (prod + the open PR's preview) against the local/source bundle. Fix #14 makes
// the PROD comparison BUMP-AWARE so a legitimate gem bump (prod still serving
// the OLD bundle until the bump merges+deploys) doesn't red the REQUIRED gate,
// while REAL prod drift at the SAME version still hard-fails. The required gate
// is the PR's OWN preview byte-matching the source (catches a broken preview
// build). See admin-bundle-parity.js's header for the full design + the
// index.html-manifest version marker.
const { test, expect } = require("./base");
const {
  sha256,
  decapPin,
  scriptManifest,
  bundleVersion,
  compareVersions,
  previewVsLocalVerdict,
  prodVsLocalVerdict,
} = require("./admin-bundle-parity");

// ── Fixture admin shells (the version marker = index.html bytes) ──────────
// OLD prod shell: no oauth-detector script (pre-#26).
const INDEX_OLD = [
  "<!DOCTYPE html><html><head>",
  '  <script src="https://unpkg.com/decap-cms@3.12.2/dist/decap-cms.js"></script>',
  '  <script src="posts-list-enhance.js" defer></script>',
  "</head><body></body></html>",
  "",
].join("\n");

// NEW source shell: the #26 oauth-detector <script> was ADDED — a gem bump.
// Same decap pin, but the manifest (and thus index.html bytes) changed.
const INDEX_NEW = [
  "<!DOCTYPE html><html><head>",
  '  <script src="https://unpkg.com/decap-cms@3.12.2/dist/decap-cms.js"></script>',
  '  <script src="posts-list-enhance.js" defer></script>',
  '  <script src="oauth-app-restriction-detector.js" defer></script>',
  "</head><body></body></html>",
  "",
].join("\n");

// A drifted shell at the SAME version: identical to NEW byte-for-byte is "same";
// to model SAME-version drift we keep index.html identical but drift a DIFFERENT
// file (a sibling module) — see the same-version drift test below.

function hash(s) {
  return sha256(Buffer.from(s, "utf8"));
}

test.describe("#14 admin-bundle version marker extraction", () => {
  test("decapPin reads the pinned decap-cms X.Y.Z from the shell", () => {
    expect(decapPin(INDEX_OLD)).toBe("3.12.2");
    expect(decapPin("<html>no pin here</html>")).toBeNull();
    expect(decapPin(null)).toBeNull();
  });

  test("scriptManifest lists the <script src> modules (sorted)", () => {
    expect(scriptManifest(INDEX_OLD)).toEqual([
      "https://unpkg.com/decap-cms@3.12.2/dist/decap-cms.js",
      "posts-list-enhance.js",
    ]);
    // NEW carries the extra oauth-detector module.
    expect(scriptManifest(INDEX_NEW)).toContain("oauth-app-restriction-detector.js");
  });

  test("bundleVersion keys on the index.html sha; OLD != NEW (a bump changed it)", () => {
    const oldV = bundleVersion(INDEX_OLD);
    const newV = bundleVersion(INDEX_NEW);
    expect(oldV.available).toBe(true);
    expect(oldV.sha).toBe(hash(INDEX_OLD));
    expect(oldV.sha).not.toBe(newV.sha); // adding a <script> = a new version
  });

  test("bundleVersion(null) is unavailable (marker can't be read)", () => {
    expect(bundleVersion(null)).toEqual({ available: false, sha: null, pin: null, manifest: [] });
  });
});

test.describe("#14 compareVersions — same vs. bump-in-progress", () => {
  test("identical shells → same version, no bump", () => {
    const v = compareVersions(INDEX_NEW, INDEX_NEW);
    expect(v.determinable).toBe(true);
    expect(v.sameVersion).toBe(true);
    expect(v.bumpInProgress).toBe(false);
  });

  test("prod OLD vs local NEW → bump in progress (prod lags)", () => {
    const v = compareVersions(INDEX_OLD, INDEX_NEW);
    expect(v.determinable).toBe(true);
    expect(v.sameVersion).toBe(false);
    expect(v.bumpInProgress).toBe(true);
  });

  test("indeterminate marker (prod unreadable) fails safe to bump-in-progress", () => {
    const v = compareVersions(null, INDEX_NEW);
    expect(v.determinable).toBe(false);
    expect(v.sameVersion).toBe(false);
    expect(v.bumpInProgress).toBe(true); // fail-safe: don't hard-fail prod when we can't prove sameness
  });
});

// ── (a) version-mismatch prod-lag → PASS (informational) ──────────────────
test.describe("#14 (a) bump-in-progress prod lag is INFORMATIONAL, not a failure", () => {
  // The bump: prod serves INDEX_OLD, source/local is INDEX_NEW. The new
  // oauth-detector.js exists locally but prod 404s it (not deployed yet), AND
  // index.html itself differs prod-vs-local. Neither may HARD-FAIL.
  const versions = compareVersions(INDEX_OLD, INDEX_NEW);

  test("prod-vs-local index.html byte mismatch during a bump → info (not fail)", () => {
    const prod = { status: 200, sha: hash(INDEX_OLD) };
    const local = { sha: hash(INDEX_NEW) };
    const v = prodVsLocalVerdict("index.html", prod, local, versions);
    expect(v.kind).toBe("info");
    expect(v.reason).toMatch(/bump in progress|reconcile on deploy/i);
  });

  test("prod 404 for a file the bump ADDS → info (prod lags), not fail", () => {
    const prod = { status: 404, sha: null };
    const local = { sha: hash("// new oauth-detector body") };
    const v = prodVsLocalVerdict("oauth-app-restriction-detector.js", prod, local, versions);
    expect(v.kind).toBe("info");
  });

  test("a non-index file whose bytes changed in the bump → info during the bump", () => {
    const prod = { status: 200, sha: hash("// old posts-list body") };
    const local = { sha: hash("// new posts-list body (bumped)") };
    const v = prodVsLocalVerdict("posts-list-enhance.js", prod, local, versions);
    expect(v.kind).toBe("info");
  });
});

// ── (b) same-version prod byte-drift → FAIL ───────────────────────────────
test.describe("#14 (b) same-version prod byte-drift HARD-FAILS (drift preserved)", () => {
  // Same bundle version: prod's index.html == local's index.html (identical
  // manifest), so any OTHER file diverging is real drift (hand-edited prod /
  // partial deploy), NOT a bump lag.
  const versions = compareVersions(INDEX_NEW, INDEX_NEW);

  test("identical version but a module's bytes differ → fail", () => {
    expect(versions.sameVersion).toBe(true);
    const prod = { status: 200, sha: hash("// drifted prod body") };
    const local = { sha: hash("// canonical source body") };
    const v = prodVsLocalVerdict("posts-list-enhance.js", prod, local, versions);
    expect(v.kind).toBe("fail");
    expect(v.reason).toMatch(/PROD DRIFT at the SAME bundle version/);
  });

  test("same version, prod 404 a file source HAS → fail (prod missing a served file)", () => {
    const prod = { status: 404, sha: null };
    const local = { sha: hash("// a module that should be served") };
    const v = prodVsLocalVerdict("preview-bridge.js", prod, local, versions);
    expect(v.kind).toBe("fail");
  });

  test("same version, prod serves a file source REMOVED → fail (stale prod file)", () => {
    const prod = { status: 200, sha: hash("// stale removed module") };
    const local = { sha: null }; // absent in source
    const v = prodVsLocalVerdict("removed-module.js", prod, local, versions);
    expect(v.kind).toBe("fail");
  });

  test("same version, bytes match → pass", () => {
    const same = hash("// identical body");
    const v = prodVsLocalVerdict(
      "preview-bridge.js",
      { status: 200, sha: same },
      { sha: same },
      versions,
    );
    expect(v.kind).toBe("pass");
  });
});

// ── (c) preview != local → FAIL (broken preview build; the REQUIRED gate) ──
test.describe("#14 (c) REQUIRED gate: preview must byte-match the PR source", () => {
  test("preview bytes != local bytes → fail (broken preview build)", () => {
    const v = previewVsLocalVerdict(
      "index.html",
      { status: 200, sha: hash(INDEX_OLD) }, // preview built stale/broken
      { sha: hash(INDEX_NEW) }, // PR source
    );
    expect(v.kind).toBe("fail");
    expect(v.reason).toMatch(/PREVIEW BUNDLE != PR SOURCE|broken preview build/i);
  });

  test("preview bytes == local bytes → pass (preview correctly built from the PR)", () => {
    const same = hash(INDEX_NEW);
    const v = previewVsLocalVerdict(
      "index.html",
      { status: 200, sha: same },
      { sha: same },
    );
    expect(v.kind).toBe("pass");
  });

  test("preview 200 but file absent in PR source → fail (preview ships an unknown file)", () => {
    const v = previewVsLocalVerdict(
      "ghost.js",
      { status: 200, sha: hash("// surprise") },
      { sha: null },
    );
    expect(v.kind).toBe("fail");
  });

  test("preview 404 for a file the PR adds → pass (within-PR deploy lag, not a build break)", () => {
    const v = previewVsLocalVerdict(
      "oauth-app-restriction-detector.js",
      { status: 404, sha: null },
      { sha: hash("// new module the PR adds") },
    );
    expect(v.kind).toBe("pass");
  });

  test("no preview env (no open PR) → pass (nothing to gate here)", () => {
    const v = previewVsLocalVerdict("index.html", null, { sha: hash(INDEX_NEW) });
    expect(v.kind).toBe("pass");
  });

  test("preview 500 → fail (broken preview response)", () => {
    const v = previewVsLocalVerdict(
      "index.html",
      { status: 500, sha: null },
      { sha: hash(INDEX_NEW) },
    );
    expect(v.kind).toBe("fail");
  });
});

// ── The headline acceptance criteria, stated as one matrix ────────────────
test.describe("#14 outcome matrix (the fix's contract)", () => {
  test("bump PR (prod older version): parity PASSES via preview-vs-local; prod is info", () => {
    const versions = compareVersions(INDEX_OLD, INDEX_NEW); // prod lags
    // Required gate: preview built from the PR == source → pass.
    const required = previewVsLocalVerdict(
      "index.html",
      { status: 200, sha: hash(INDEX_NEW) },
      { sha: hash(INDEX_NEW) },
    );
    // Prod side at the bumped file → informational, NOT a fail.
    const prodSide = prodVsLocalVerdict(
      "index.html",
      { status: 200, sha: hash(INDEX_OLD) },
      { sha: hash(INDEX_NEW) },
      versions,
    );
    expect(required.kind).toBe("pass");
    expect(prodSide.kind).toBe("info");
  });

  test("same-version prod byte-drift: parity FAILS on the prod side", () => {
    const versions = compareVersions(INDEX_NEW, INDEX_NEW); // same version
    const prodSide = prodVsLocalVerdict(
      "posts-list-enhance.js",
      { status: 200, sha: hash("drifted") },
      { sha: hash("canonical") },
      versions,
    );
    expect(prodSide.kind).toBe("fail");
  });
});
