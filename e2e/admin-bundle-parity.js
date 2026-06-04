// Pure, network-free decision logic for the admin-bundle byte-parity probe
// (admin-bundle-parity.spec.js, fix #14). Extracted so the bump-window
// semantics are unit-testable with fixtures/mocks (admin-bundle-parity.test.js)
// — no live fetches.
//
// ── THE BUMP-WINDOW PROBLEM (fix #14) ────────────────────────────────────
// The parity probe byte-compares the served admin bundle (prod + the open PR's
// preview) against the local working-tree/gem source. When a GEM BUMP changes
// the admin bundle (e.g. v0.1.x adds a <script> to theme/admin/index.html — the
// #26 oauth-detector, confirmed on adamdaniel #1913), PROD legitimately LAGS:
// it keeps serving the OLD bundle until the bump PR merges + deploys. So a
// REQUIRED prod-vs-source byte check fails pre-merge with a prod≠source
// mismatch — a chicken-and-egg: prod can't match until the very PR that updates
// it merges.
//
// THE FIX preserves prod-drift detection but tolerates ONLY a legitimate
// bump-in-progress, keyed on a VERSION MARKER the served HTML exposes:
//
//   REQUIRED (hard gate)  = the PR's OWN preview bundle byte-matches local/
//                           source. This catches the real per-PR risk — a
//                           BROKEN PREVIEW BUILD (the preview deployed bytes
//                           that DON'T match what's in the PR).
//
//   PROD (bump-aware)     = compare prod's served bundle VERSION to the PR's
//                           source version:
//                             • versions DIFFER  → a bump is in progress; prod
//                               legitimately lags. Any prod-vs-source byte
//                               mismatch is INFORMATIONAL (logged, not failed).
//                             • versions MATCH but bytes DIFFER → REAL prod
//                               drift (someone hand-edited prod, or a deploy
//                               partially failed at the SAME version) → HARD
//                               FAIL. This preserves the original probe intent.
//
// ── THE VERSION MARKER ───────────────────────────────────────────────────
// The served admin shell `index.html` IS the bundle MANIFEST: every shipped
// admin module appears as a `<script src="…">` tag in it, so ANY bundle change
// that adds/removes/renames a module (exactly the #1913 oauth-detector bump)
// changes index.html's bytes. We therefore define the served "bundle version"
// as the sha256 of `index.html`. Two corroborating signals are also extracted
// from it for diagnostics + a stronger same-version assertion:
//   • the pinned `decap-cms@X.Y.Z` tag (the marker cms-bundle-version.spec.js
//     already keys on), and
//   • the sorted list of `<script src>` module names (the manifest).
// "Same version" ⇔ identical index.html sha; that is the strict, byte-exact
// definition — a prod whose manifest matches local's to the byte is unambiguous-
// ly the same bundle generation, so a divergence in any OTHER file at that
// point is real drift, not lag.
//
// If the marker is UNAVAILABLE (prod's index.html 404s / is unreadable, or local
// index.html is missing), we CANNOT prove same-vs-different version, so we FAIL
// SAFE toward "bump in progress" for the PROD side (informational) — prod-drift
// at an indeterminate version is then caught by the scheduled canary-prod lane,
// not this per-PR gate. The REQUIRED preview-vs-local gate is unaffected (it
// never depends on prod).
const crypto = require("node:crypto");

const ADMIN_PREFIX = "admin";
// The manifest/version marker file. Its bytes change on every bundle module
// add/remove/rename, so its sha256 is the served "bundle version".
const MANIFEST_FILE = "index.html";

// sha256 of a Buffer/Uint8Array/string → hex.
function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// Extract the pinned decap-cms X.Y.Z from an index.html string (or null).
function decapPin(html) {
  if (typeof html !== "string") return null;
  const m = html.match(/decap-cms@(\d+\.\d+\.\d+)\//);
  return m ? m[1] : null;
}

// Extract the sorted list of local `<script src="…">` module names from an
// index.html string (the bundle manifest). Absolute/CDN srcs (decap-cms itself)
// are kept too — a decap pin bump shows up here as well.
function scriptManifest(html) {
  if (typeof html !== "string") return [];
  const out = [];
  const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out.sort();
}

// Build a structured "bundle version" descriptor from an index.html STRING.
// `sha` is the byte-exact version key; `pin`/`manifest` are diagnostics.
function bundleVersion(html) {
  if (typeof html !== "string") {
    return { available: false, sha: null, pin: null, manifest: [] };
  }
  return {
    available: true,
    sha: sha256(Buffer.from(html, "utf8")),
    pin: decapPin(html),
    manifest: scriptManifest(html),
  };
}

// Are prod and the local/source bundle the SAME generation? Same ⇔ identical
// manifest sha. When EITHER side's marker is unavailable we can't prove
// sameness → treat as a (possible) bump in progress (fail-safe to informational
// on the prod side).
//
// Returns { sameVersion, bumpInProgress, determinable } where
//   determinable = both markers were available.
function compareVersions(prodHtml, localHtml) {
  const prod = bundleVersion(prodHtml);
  const local = bundleVersion(localHtml);
  const determinable = prod.available && local.available;
  const sameVersion = determinable && prod.sha === local.sha;
  return {
    determinable,
    sameVersion,
    bumpInProgress: !sameVersion, // includes the indeterminate case (fail-safe)
    prod,
    local,
  };
}

// Acceptable "file absent" statuses during a deploy/merge window.
const ACCEPTABLE_MISSING = new Set([404]);

// ── Per-file verdicts ────────────────────────────────────────────────────
// REQUIRED preview-vs-local gate. `preview`/`local` are { status, sha } (status
// optional for local — a local read either yields a sha or null). Returns a
// verdict object: { kind: "pass"|"fail", reason }.
//
// The per-PR risk this gates: a BROKEN PREVIEW BUILD — the preview deployed
// bytes that don't match what the PR actually contains. That is always a hard
// fail (it's the PR's own output, no lag excuse).
function previewVsLocalVerdict(rel, preview, local) {
  // No preview environment at all (no open PR) → nothing to gate here; the
  // caller skips the required check and the orchestrator notes it.
  if (!preview) return { kind: "pass", reason: `${rel}: no preview env (skipped)` };

  const previewMissing = ACCEPTABLE_MISSING.has(preview.status);
  const localMissing = !local || local.sha == null;

  // Both absent → consistent absence (file added on neither, or removed on
  // both). Fine.
  if (previewMissing && localMissing) {
    return { kind: "pass", reason: `${rel}: absent on both preview + local` };
  }
  // Preview has it but it's NOT a 200 and NOT a 404 (e.g. 500/403) → broken.
  if (preview.status !== 200 && !previewMissing) {
    return {
      kind: "fail",
      reason: `${rel}: preview returned ${preview.status} (expected 200 or 404)`,
    };
  }
  // Preview 404 while local has the file → the PR adds this file; preview's
  // deploy hasn't published it yet OR it's excluded. This is a within-PR
  // deploy-lag, not a build mismatch — tolerate (informational handled by the
  // caller; treat as pass for the hard gate).
  if (previewMissing && !localMissing) {
    return { kind: "pass", reason: `${rel}: preview 404, local present (within-PR deploy lag)` };
  }
  // Preview 200 while local missing → preview ships a file the PR's tree
  // doesn't have. That's a real preview/source divergence → fail.
  if (!previewMissing && localMissing) {
    return {
      kind: "fail",
      reason: `${rel}: preview serves this file (200) but it's absent in the PR's local tree`,
    };
  }
  // Both present (200 + local sha). The hard gate: bytes MUST match.
  if (preview.sha === local.sha) {
    return { kind: "pass", reason: `${rel}: preview == local` };
  }
  return {
    kind: "fail",
    reason:
      `${rel}: PREVIEW BUNDLE != PR SOURCE (broken preview build)\n` +
      `      preview sha=${preview.sha}\n` +
      `      local   sha=${local.sha}`,
  };
}

// PROD bump-aware verdict. `prod`/`local` are { status, sha }. `versions` is the
// result of compareVersions(prodHtml, localHtml). Returns
// { kind: "pass"|"fail"|"info", reason }.
//   - "fail" → REAL prod drift at the SAME bundle version (hard gate).
//   - "info" → a legitimate bump-in-progress lag (logged, not failed).
//   - "pass" → prod matches source (or a tolerable absence).
function prodVsLocalVerdict(rel, prod, local, versions) {
  const prodMissing = ACCEPTABLE_MISSING.has(prod.status);
  const localMissing = !local || local.sha == null;

  if (prodMissing && localMissing) {
    return { kind: "pass", reason: `${rel}: absent on both prod + local` };
  }
  // Prod responded with something other than 200/404 → real breakage,
  // independent of any bump.
  if (prod.status !== 200 && !prodMissing) {
    return { kind: "fail", reason: `${rel}: prod returned ${prod.status} (expected 200 or 404)` };
  }
  // Prod 404 while local present → the file is new on the source (this bump
  // adds it); prod hasn't deployed it yet. Bump lag → informational.
  if (prodMissing && !localMissing) {
    return {
      kind: versions.sameVersion ? "fail" : "info",
      reason: versions.sameVersion
        ? `${rel}: prod 404 but local present at the SAME bundle version — prod is missing a file it should serve (drift)`
        : `${rel}: prod 404, local present (bump in progress — prod lags; reconciles on deploy)`,
    };
  }
  // Prod 200 while local missing → prod serves a file the source removed in
  // this bump. Same version ⇒ drift; different version ⇒ bump removes it → lag.
  if (!prodMissing && localMissing) {
    return {
      kind: versions.sameVersion ? "fail" : "info",
      reason: versions.sameVersion
        ? `${rel}: prod serves this file (200) but it's absent in source at the SAME version (drift)`
        : `${rel}: prod serves a file this bump removes (bump in progress — reconciles on deploy)`,
    };
  }
  // Both present. Bytes match → pass.
  if (prod.sha === local.sha) {
    return { kind: "pass", reason: `${rel}: prod == local` };
  }
  // Bytes differ. THE bump-window decision:
  //   • different version (bump in progress) → INFORMATIONAL lag.
  //   • same version → REAL prod drift → HARD FAIL.
  if (versions.sameVersion) {
    return {
      kind: "fail",
      reason:
        `${rel}: PROD DRIFT at the SAME bundle version\n` +
        `      prod  sha=${prod.sha}\n` +
        `      local sha=${local.sha}\n` +
        `      (prod's index.html manifest matches local's, so this is not a bump lag)`,
    };
  }
  return {
    kind: "info",
    reason:
      `${rel}: prod lags ${describeVersion(versions.prod)} -> ${describeVersion(versions.local)}; ` +
      `will reconcile on deploy (bump in progress — prod-vs-source mismatch is informational)`,
  };
}

// Short human label for a bundleVersion descriptor (for the lag log line).
function describeVersion(v) {
  if (!v || !v.available) return "v(unknown)";
  const pin = v.pin ? `decap@${v.pin}` : "decap@?";
  return `${pin}/manifest:${v.sha ? v.sha.slice(0, 8) : "????????"}`;
}

module.exports = {
  ADMIN_PREFIX,
  MANIFEST_FILE,
  ACCEPTABLE_MISSING,
  sha256,
  decapPin,
  scriptManifest,
  bundleVersion,
  compareVersions,
  previewVsLocalVerdict,
  prodVsLocalVerdict,
  describeVersion,
};
