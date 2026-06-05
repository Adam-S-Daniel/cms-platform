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
  isInjectedShell,
  normalizeInjectedIdentity,
  parityShaForFile,
  isExcludedAdminPath,
} = require("./admin-bundle-parity");
const fs = require("node:fs");
const path = require("node:path");

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

// ──────────────────────────────────────────────────────────────────────────
// #17 — preview-vs-local must NORMALIZE the per-env window.CMS_* injection.
//
// REGRESSION (from #14): the new REQUIRED preview-vs-local gate byte-compares
// the SERVED preview shell (which carries the per-environment window.CMS_*
// injection the render hook splices in — CMS_REPO / CMS_SITE_ORIGIN / CMS_APEX
// / CMS_OAUTH_BASE_URL / CMS_SITE_TITLE) against the LOCAL source shell (which
// carries either the raw {{CMS_*}} tokens or a DIFFERENT injected identity).
// On the three injected shells (admin/index.html + admin/reviews/*.html) the
// machinery is identical but the injected IDENTITY differs, so the raw-byte
// sha mismatches and the REQUIRED gate FALSE-FAILS ("PREVIEW BUNDLE != PR
// SOURCE") on EVERY admin PR (confirmed adamdaniel #1913).
//
// FIX: before sha-ing the INJECTED shells, normalize the per-env injection in
// BOTH the preview bytes AND the local bytes — replace each
// `window.CMS_<KEY> = <value>` assignment VALUE (and any leftover
// `{{CMS_<KEY>}}` token) with a fixed per-key placeholder. The comparison then
// runs on the MACHINERY (script tags, structure, WHICH keys are injected) not
// the injected identity. Non-injected machinery stays STRICT.

// The injected <script> the render hooks splice after <head> (one line; values
// from Ruby's .inspect, i.e. double-quoted). Same 5 keys both render paths
// inject (AGENTS.md / decap-config-render-parity.test.js).
function injectedScript({ repo, origin, apex, oauth, title }) {
  return (
    `<script>window.CMS_REPO=${JSON.stringify(repo)};` +
    `window.CMS_SITE_ORIGIN=${JSON.stringify(origin)};` +
    `window.CMS_APEX=${JSON.stringify(apex)};` +
    `window.CMS_OAUTH_BASE_URL=${JSON.stringify(oauth)};` +
    `window.CMS_SITE_TITLE=${JSON.stringify(title)};</script>`
  );
}

// An injected shell as the PREVIEW serves it: identity = the served preview
// origin/title. `extraScript` lets a test add a machinery line (a new module).
function injectedShellHtml(identity, extraScript = "") {
  return [
    "<!DOCTYPE html><html><head>",
    injectedScript(identity),
    '  <script src="https://unpkg.com/decap-cms@3.12.2/dist/decap-cms.js"></script>',
    '  <script src="posts-list-enhance.js" defer></script>',
    extraScript,
    "</head><body><div id=root></div></body></html>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// The SAME shell as it lives in LOCAL SOURCE (theme/admin/*.html): NO injected
// identity <script> block at all — the source only READS window.CMS_* at
// runtime (the render hook splices the block in at build). This is the real
// #1913 asymmetry: preview has the block, source does not. `extraScript` lets a
// test add a machinery line so a genuine source/preview machinery diff shows.
function sourceShellHtml(extraScript = "") {
  return [
    "<!DOCTYPE html><html><head>",
    '  <script src="https://unpkg.com/decap-cms@3.12.2/dist/decap-cms.js"></script>',
    '  <script src="posts-list-enhance.js" defer></script>',
    extraScript,
    "</head><body><div id=root></div></body></html>",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

// PREVIEW identity (served from the PR's preview subdomain).
const PREVIEW_IDENTITY = {
  repo: "Adam-S-Daniel/adamdaniel.ai",
  origin: "https://preview-pr1913.adamdaniel.ai",
  apex: "adamdaniel.ai",
  oauth: "https://oauth.adamdaniel.ai",
  title: "Adam Daniel",
};
// "LOCAL source" rendered at PROD identity (apex origin) — same machinery,
// different injected identity than the preview.
const PROD_IDENTITY = {
  repo: "Adam-S-Daniel/adamdaniel.ai",
  origin: "https://adamdaniel.ai",
  apex: "adamdaniel.ai",
  oauth: "https://oauth.adamdaniel.ai",
  title: "Adam Daniel",
};
// "LOCAL source" as the RAW template (un-rendered {{CMS_*}} tokens) — the other
// shape the spec's local computation can take. Built from the SAME machinery as
// `injectedShellHtml` (identical structure + trailing newline) so it differs
// from a served shell ONLY in the injected identity values (here: raw tokens).
const TOKEN_IDENTITY = {
  repo: "{{CMS_REPO}}",
  origin: "{{CMS_SITE_URL}}",
  apex: "{{CMS_APEX}}",
  oauth: "{{CMS_OAUTH_BASE_URL}}",
  title: "{{CMS_DISPLAY_URL}}",
};
const TOKEN_SHELL = injectedShellHtml(TOKEN_IDENTITY);

test.describe("#17 isInjectedShell classifies the window.CMS_*-injected admin shells", () => {
  test("admin-root index*.html + reviews/*.html are injected shells", () => {
    expect(isInjectedShell("index.html")).toBe(true);
    expect(isInjectedShell("reviews/index.html")).toBe(true);
    expect(isInjectedShell("reviews/health.html")).toBe(true);
  });
  test("non-injected machinery files are NOT injected shells", () => {
    expect(isInjectedShell("posts-list-enhance.js")).toBe(false);
    expect(isInjectedShell("preview-bridge.js")).toBe(false);
    expect(isInjectedShell("admin-mobile.css")).toBe(false);
    // a nested non-html or a non-reviews html sub-path is not an injected shell
    expect(isInjectedShell("reviews/app.js")).toBe(false);
  });
});

test.describe("#17 normalizeInjectedIdentity collapses per-env window.CMS_* identity", () => {
  test("two shells differing ONLY in injected identity normalize-equal", () => {
    const a = injectedShellHtml(PREVIEW_IDENTITY);
    const b = injectedShellHtml(PROD_IDENTITY);
    expect(a).not.toBe(b); // raw bytes differ (the regression)
    expect(normalizeInjectedIdentity(a)).toBe(normalizeInjectedIdentity(b));
  });

  test("injected values vs raw {{CMS_*}} tokens normalize-equal", () => {
    const served = injectedShellHtml(PREVIEW_IDENTITY);
    expect(normalizeInjectedIdentity(served)).toBe(normalizeInjectedIdentity(TOKEN_SHELL));
  });

  test("a machinery line (added <script src>) still differs after normalization", () => {
    const plain = injectedShellHtml(PREVIEW_IDENTITY);
    const withModule = injectedShellHtml(PROD_IDENTITY, '  <script src="oauth-app-restriction-detector.js" defer></script>');
    expect(normalizeInjectedIdentity(plain)).not.toBe(normalizeInjectedIdentity(withModule));
  });

  // THE #1913 asymmetry: the SERVED shell carries the hook-injected identity
  // <script> block; the LOCAL source carries NO such block (it only READS
  // window.CMS_* at runtime). Both must normalize-equal — the block's presence
  // (and per-env values) must not register; the rest of the machinery must.
  test("served shell WITH the injected block == local source WITHOUT it (machinery identical)", () => {
    const served = injectedShellHtml(PREVIEW_IDENTITY); // hook spliced the block
    // The same shell as it lives in source: NO injected identity <script> at all.
    const source = served.replace(
      injectedScript(PREVIEW_IDENTITY) + "\n",
      "",
    );
    expect(source).not.toContain("window.CMS_REPO="); // source truly has no block
    expect(normalizeInjectedIdentity(served)).toBe(normalizeInjectedIdentity(source));
  });

  // A real inline/module script (one with a src, or non-identity statements) is
  // NOT the identity block, so it is NEVER stripped.
  test("a real <script src> module is never mistaken for the identity block", () => {
    const html = injectedShellHtml(PREVIEW_IDENTITY);
    const normalized = normalizeInjectedIdentity(html);
    expect(normalized).toContain('src="posts-list-enhance.js"');
    expect(normalized).toContain("decap-cms@3.12.2");
  });
});

test.describe("#17 parityShaForFile normalizes injected shells, leaves others raw", () => {
  test("injected shell: preview-origin vs prod-apex → SAME parity sha", () => {
    const preview = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8");
    const local = Buffer.from(injectedShellHtml(PROD_IDENTITY), "utf8");
    expect(parityShaForFile("index.html", preview)).toBe(parityShaForFile("index.html", local));
  });

  test("injected shell: served-value vs raw-token → SAME parity sha", () => {
    const preview = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8");
    const local = Buffer.from(TOKEN_SHELL, "utf8");
    expect(parityShaForFile("reviews/health.html", preview)).toBe(
      parityShaForFile("reviews/health.html", local),
    );
  });

  test("injected shell: a machinery diff → DIFFERENT parity sha", () => {
    const preview = Buffer.from(
      injectedShellHtml(PREVIEW_IDENTITY, '  <script src="oauth-app-restriction-detector.js" defer></script>'),
      "utf8",
    );
    const local = Buffer.from(injectedShellHtml(PROD_IDENTITY), "utf8");
    expect(parityShaForFile("index.html", preview)).not.toBe(
      parityShaForFile("index.html", local),
    );
  });

  test("non-injected file: NOT normalized — identical bytes → same, any diff → different", () => {
    const same = Buffer.from("// posts-list body\nconsole.log(window.CMS_REPO);\n", "utf8");
    expect(parityShaForFile("posts-list-enhance.js", same)).toBe(
      parityShaForFile("posts-list-enhance.js", Buffer.from(same)),
    );
    const a = Buffer.from('var x = window.CMS_SITE_ORIGIN; // a', "utf8");
    const b = Buffer.from('var x = window.CMS_SITE_ORIGIN; // b', "utf8");
    expect(parityShaForFile("preview-bridge.js", a)).not.toBe(
      parityShaForFile("preview-bridge.js", b),
    );
  });
});

// ── #17 end-to-end: the REQUIRED preview-vs-local gate using parity shas ────
// Feeds the verdict the same shas the SPEC feeds (parityShaForFile of preview
// bytes vs local bytes) — proving the #1913 scenario PASSES while a genuine
// broken-preview-build (machinery diff) still FAILS.
test.describe("#17 (acceptance) REQUIRED preview-vs-local with injection-normalized shas", () => {
  // (a) preview vs local differ ONLY in window.CMS_* injected values → PASS.
  test("(a) injected-shell identity-only diff (preview origin vs prod apex) → PASS", () => {
    const preview = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8");
    const local = Buffer.from(injectedShellHtml(PROD_IDENTITY), "utf8");
    const v = previewVsLocalVerdict(
      "index.html",
      { status: 200, sha: parityShaForFile("index.html", preview) },
      { sha: parityShaForFile("index.html", local) },
    );
    expect(v.kind).toBe("pass");
  });

  test("(a') injected-shell served-value vs raw {{CMS_*}} token → PASS", () => {
    const preview = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8");
    const local = Buffer.from(TOKEN_SHELL, "utf8");
    const v = previewVsLocalVerdict(
      "reviews/health.html",
      { status: 200, sha: parityShaForFile("reviews/health.html", preview) },
      { sha: parityShaForFile("reviews/health.html", local) },
    );
    expect(v.kind).toBe("pass");
  });

  // (a'') THE literal #1913 asymmetry: preview shell carries the hook-injected
  // identity block; the LOCAL source shell has NO block at all → PASS.
  test("(a'') injected-shell preview-block vs block-less source → PASS", () => {
    const preview = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8");
    const local = Buffer.from(sourceShellHtml(), "utf8");
    const v = previewVsLocalVerdict(
      "reviews/index.html",
      { status: 200, sha: parityShaForFile("reviews/index.html", preview) },
      { sha: parityShaForFile("reviews/index.html", local) },
    );
    expect(v.kind).toBe("pass");
  });

  // (b) differ in a machinery line (added <script src>) → FAIL (broken build).
  test("(b) injected-shell machinery diff (an added <script src>) → FAIL", () => {
    const preview = Buffer.from(
      injectedShellHtml(PREVIEW_IDENTITY, '  <script src="rogue-injected-module.js"></script>'),
      "utf8",
    );
    const local = Buffer.from(injectedShellHtml(PROD_IDENTITY), "utf8");
    const v = previewVsLocalVerdict(
      "index.html",
      { status: 200, sha: parityShaForFile("index.html", preview) },
      { sha: parityShaForFile("index.html", local) },
    );
    expect(v.kind).toBe("fail");
    expect(v.reason).toMatch(/PREVIEW BUNDLE != PR SOURCE|broken preview build/i);
  });

  // (c) a NON-injected file (an enhancer .js) byte diff → still FAIL.
  test("(c) non-injected enhancer .js byte diff → still FAIL", () => {
    const preview = Buffer.from("// preview build of posts-list (stale)\n", "utf8");
    const local = Buffer.from("// PR source of posts-list (correct)\n", "utf8");
    const v = previewVsLocalVerdict(
      "posts-list-enhance.js",
      { status: 200, sha: parityShaForFile("posts-list-enhance.js", preview) },
      { sha: parityShaForFile("posts-list-enhance.js", local) },
    );
    expect(v.kind).toBe("fail");
  });
});

// ── #17 (the #1913 scenario, realistic fixture bytes) ─────────────────────
// Reproduce all three injected shells the way #1913 actually presents them:
// the PREVIEW serves the shell WITH the hook-injected preview-origin identity
// <script> block; the LOCAL source (theme/admin/*.html) has NO injected block
// at all (it only READS window.CMS_* at runtime). All three must normalize-
// equal → the REQUIRED gate PASSES; a genuine machinery break on ANY of them
// still fails.
test.describe("#17 (#1913) the three injected shells normalize-equal end-to-end", () => {
  const SHELLS = ["index.html", "reviews/index.html", "reviews/health.html"];

  test("all three injected shells PASS (preview-injected vs block-less source), zero failures", () => {
    const failures = [];
    for (const rel of SHELLS) {
      const previewBytes = Buffer.from(injectedShellHtml(PREVIEW_IDENTITY), "utf8"); // served: block present
      const localBytes = Buffer.from(sourceShellHtml(), "utf8"); // source: NO block
      const v = previewVsLocalVerdict(
        rel,
        { status: 200, sha: parityShaForFile(rel, previewBytes) },
        { sha: parityShaForFile(rel, localBytes) },
      );
      if (v.kind === "fail") failures.push(v.reason);
    }
    expect(failures).toEqual([]);
  });

  test("a genuine broken-preview-build on one injected shell STILL fails", () => {
    const rel = "reviews/health.html";
    const previewBytes = Buffer.from(
      injectedShellHtml(PREVIEW_IDENTITY, '  <script src="smuggled.js"></script>'),
      "utf8",
    );
    const localBytes = Buffer.from(sourceShellHtml(), "utf8");
    const v = previewVsLocalVerdict(
      rel,
      { status: 200, sha: parityShaForFile(rel, previewBytes) },
      { sha: parityShaForFile(rel, localBytes) },
    );
    expect(v.kind).toBe("fail");
  });
});

// ── #17 version marker (index.html) is ALSO normalized for compareVersions ──
// index.html IS an injected shell. The spec normalizes BOTH the prod-served and
// the local-source index.html before compareVersions(), so "same bundle
// version" reflects the MACHINERY/manifest, not the per-env identity block —
// otherwise prod (block present) vs local source (block absent) would ALWAYS
// read as a bump and the #14 same-version prod-drift HARD FAIL could never fire.
test.describe("#17 version marker normalizes the injected identity for sameVersion", () => {
  test("served (block + preview origin) vs source (no block), same modules → SAME version", () => {
    const served = injectedShellHtml(PREVIEW_IDENTITY); // prod/preview-served: block present
    const source = sourceShellHtml(); // local source: no block
    const v = compareVersions(
      normalizeInjectedIdentity(served),
      normalizeInjectedIdentity(source),
    );
    expect(v.determinable).toBe(true);
    expect(v.sameVersion).toBe(true); // identity differs, machinery identical → same generation
  });

  test("served with a REAL extra module vs source → DIFFERENT version (bump in progress)", () => {
    const served = injectedShellHtml(PREVIEW_IDENTITY, '  <script src="oauth-app-restriction-detector.js"></script>');
    const source = sourceShellHtml(); // missing that module
    const v = compareVersions(
      normalizeInjectedIdentity(served),
      normalizeInjectedIdentity(source),
    );
    expect(v.sameVersion).toBe(false); // a real <script src> add = a new bundle generation
  });

  test("normalizeInjectedIdentity(null) stays null → marker indeterminate", () => {
    expect(normalizeInjectedIdentity(null)).toBeNull();
    const v = compareVersions(normalizeInjectedIdentity(null), normalizeInjectedIdentity(sourceShellHtml()));
    expect(v.determinable).toBe(false);
    expect(v.bumpInProgress).toBe(true); // fail-safe
  });
});


// ── Served-file exclusion: the parity walk must skip files the deploy COPY
//    hook never publishes to _site/admin (fix: false same-version "drift" on a
//    bump that ADDS source-only files). ─────────────────────────────────────
//
// ROOT CAUSE (adamdaniel #1922 / v0.1.13 bump): the BUMP-AWARE prod gate keys
// "same version" on the served index.html manifest sha. v0.1.13 added
// theme/admin/collections.site.yml.example + README.md — SOURCE/DOC files the
// deploy copy hook (theme/lib/cms-platform-theme/decap_config_hook.rb) and its
// deploy-time mirror (scripts/render-decap-config.rb) EXPLICITLY SKIP from
// _site/admin (`next if bn.end_with?(".base.yml") || skip.include?(bn)`). They
// 404 on prod AND preview — never served. But index.html (the version marker)
// is a <script src> manifest, blind to these non-script sidecars, so it stayed
// byte-identical → the gate read "same version" and flagged prod's legitimate
// 404 as drift. The walk must EXCLUDE exactly what the hook skips.
test.describe("served-file exclusion mirrors the deploy copy hook", () => {
  test("source/doc files the hook SKIPS are excluded (never served → not walked)", () => {
    for (const rel of [
      "README.md",
      "collections.site.yml",
      "collections.site.yml.example",
    ]) {
      expect(isExcludedAdminPath(rel), `${rel} must be excluded`).toBe(true);
    }
  });

  test("base templates (*.base.yml) are excluded — the hook renders, never copies them", () => {
    expect(isExcludedAdminPath("config.base.yml")).toBe(true);
    expect(isExcludedAdminPath("config-local.base.yml")).toBe(true);
  });

  test("per-deploy + preview-mutated + dev/test-only files stay excluded (unchanged contract)", () => {
    for (const rel of [
      "commit.json",
      "config.yml",
      "config-local.yml",
      "config-test.yml",
      "index-local.html",
      "index-test.html",
    ]) {
      expect(isExcludedAdminPath(rel), `${rel} must be excluded`).toBe(true);
    }
  });

  test("genuinely-served bundle files are NOT excluded (still parity-checked)", () => {
    for (const rel of [
      "index.html",
      "field_library.yml",
      "posts-list-enhance.js",
      "admin-mobile.css",
      "oauth-app-restriction-detector.js",
      "reviews/health.html",
    ]) {
      expect(isExcludedAdminPath(rel), `${rel} must be served/walked`).toBe(false);
    }
  });

  test("path separators normalize (Windows rel) — reviews\\\\x.html is still served", () => {
    expect(isExcludedAdminPath("reviews\\health.html")).toBe(false);
  });

  test("non-string input is not excluded (defensive)", () => {
    expect(isExcludedAdminPath(null)).toBe(false);
    expect(isExcludedAdminPath(undefined)).toBe(false);
  });

  // DRIFT GUARD: parse the Ruby skip list out of BOTH the build-time hook and
  // its deploy-time mirror and assert the JS predicate excludes every basename
  // they skip. If someone adds a 4th source-only file to the Ruby skip arrays
  // (or the `.base.yml` suffix rule), this fails until the JS walk matches —
  // the two can never silently diverge.
  test("JS exclusion stays in lockstep with the Ruby copy-hook skip list", () => {
    const rubyFiles = [
      path.join(__dirname, "..", "theme", "lib", "cms-platform-theme", "decap_config_hook.rb"),
      path.join(__dirname, "..", "scripts", "render-decap-config.rb"),
    ];
    let checkedAnySkip = false;
    let checkedAnyBase = false;
    for (const f of rubyFiles) {
      const src = fs.readFileSync(f, "utf8");
      // skip = ['a', 'b', "c"]  (single or double quotes)
      const m = src.match(/skip\s*=\s*\[([^\]]*)\]/);
      expect(m, `${path.basename(f)} must declare a skip = [...] array`).toBeTruthy();
      const names = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
      expect(names.length, `${path.basename(f)} skip list must be non-empty`).toBeGreaterThan(0);
      for (const bn of names) {
        checkedAnySkip = true;
        expect(isExcludedAdminPath(bn), `${path.basename(f)} skips ${bn} → JS must exclude it`).toBe(true);
      }
      // the `.base.yml` suffix rule must also be honored by the JS predicate
      if (/end_with\?\(['"]\.base\.yml['"]\)/.test(src)) {
        checkedAnyBase = true;
        expect(isExcludedAdminPath("anything.base.yml")).toBe(true);
      }
    }
    expect(checkedAnySkip, "parsed at least one Ruby skip basename").toBe(true);
    expect(checkedAnyBase, "parsed the .base.yml suffix rule").toBe(true);
  });
});
