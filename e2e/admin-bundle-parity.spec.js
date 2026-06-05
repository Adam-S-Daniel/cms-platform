// @lane: real — fetches admin/ bytes from https://adamdaniel.ai and the live PR preview to compare
const { test, expect } = require("./base");
const fs = require("fs");
const path = require("path");
const {
  MANIFEST_FILE,
  compareVersions,
  previewVsLocalVerdict,
  prodVsLocalVerdict,
  describeVersion,
  parityShaForFile,
  normalizeInjectedIdentity,
  isExcludedAdminPath,
} = require("./admin-bundle-parity");

// G2 — Admin bundle byte-parity probe (BUMP-AWARE, fix #14).
//
// Walks the local `theme/admin/` source tree and GETs each shipped file
// against:
//
//   1. https://adamdaniel.ai/admin/<path>                  — production
//   2. https://preview-pr<N>.adamdaniel.ai/admin/<path>    — latest open PR
//
// Compares sha256 of the body bytes per file. Two gates, with different
// strictness, so a legitimate gem bump (prod still serving the OLD bundle
// until the bump merges + deploys) doesn't red the REQUIRED check while
// real prod drift still hard-fails:
//
//   REQUIRED (hard gate) — the PR's OWN preview bundle byte-matches the
//     local/source tree. This catches the real PER-PR risk: a BROKEN
//     PREVIEW BUILD (preview deployed bytes that don't match the PR). No
//     bump excuse applies — it's the PR's own output.
//
//   PROD (bump-aware) — compare prod's served bundle VERSION to the PR's
//     source version (the version marker = the served `index.html`
//     manifest sha; see admin-bundle-parity.js). If they DIFFER a bump is
//     in progress and prod legitimately lags → any prod-vs-source byte
//     mismatch is INFORMATIONAL (logged, not failed). If they MATCH yet
//     bytes differ → REAL prod drift (hand-edited prod / partial deploy at
//     the SAME version) → HARD FAIL. This preserves the original
//     prod-drift intent (confirmed on adamdaniel #1913, where the ONLY
//     prod-vs-PR diff was the intended #26 oauth-detector <script> — a
//     bump, not drift).
//
// Tagged @parity (G3): the spec is read-only — no writes, no admin
// session, no decap-server. Safe to run on every PR against live
// surfaces. `chromium-desktop-3k` only — one HTTP-only walk is enough.
//
// Excluded paths:
//   - admin/commit.json — auto-generated per deploy, will always
//     differ between prod and preview by definition.
//   - admin/config*.yml — `scripts/patch-preview-config.sh` mutates
//     `site_url`, `display_url`, and `backend.branch` for previews,
//     so config-* files are not byte-identical by design. The
//     allowlisted-delta invariant is owned by the sibling spec
//     `cms-config-preview-delta.spec.js` (G1).
//   - admin/index-local.html, admin/index-test.html — local-dev /
//     e2e-test admin shells. They're built into `_site/` so the
//     local Playwright suite can hit them via `jekyll build && serve
//     _site`, but deploy-{production,preview}.yml drop them from
//     the S3 sync (`--exclude`) — they wire up localhost-only
//     backends and have no business being on the CDN.
//   - admin/*.base.yml, admin/collections.site.yml[.example],
//     admin/README.md — source/doc-only files the deploy COPY hook
//     (decap_config_hook.rb) + its mirror (render-decap-config.rb)
//     SKIP from _site/admin, so they 404 on prod AND preview. Walking
//     one would false-fail the bump-aware prod gate as "drift" when a
//     bump adds it (adamdaniel #1922 / v0.1.13). The exclusion is
//     centralized in admin-bundle-parity.js's isExcludedAdminPath()
//     and lock-tested against the Ruby skip arrays.

const PROD_BASE = "https://adamdaniel.ai";
const ADMIN_PREFIX = "admin";

// 404 is acceptable for files added on a not-yet-merged PR or just
// removed on the working tree — the bump-aware handlers downgrade such
// mismatches to a fail/info verdict per the version comparison.
const ACCEPTABLE_STATUSES_MISSING = new Set([404]);

function listAdminFiles(adminDir) {
  // Walk the tree recursively. Node 18+ supports { recursive: true } on
  // readdirSync — and the rest of this repo runs on Node 20.
  const entries = fs.readdirSync(adminDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      // dirent.parentPath is Node 20+, dirent.path is Node 18 fallback.
      const dir = e.parentPath || e.path;
      return path.relative(adminDir, path.join(dir, e.name));
    });
}

function isExcluded(relPath) {
  // Delegate to the testable predicate (admin-bundle-parity.js): a file is
  // excluded from the walk iff the deploy never serves it — the per-deploy
  // commit.json, the preview-mutated/dev-only config*.yml + *-local/*-test
  // shells, AND the source/doc-only files the deploy COPY hook skips from
  // _site/admin (*.base.yml, collections.site.yml[.example], README.md). The
  // hook (decap_config_hook.rb) is the authority; admin-bundle-parity.test.js
  // locks this predicate to its skip list so they can't diverge. Walking a
  // never-served file would false-fail the BUMP-AWARE prod gate as drift when
  // a bump adds one (adamdaniel #1922 / v0.1.13: README.md + .example).
  return isExcludedAdminPath(relPath);
}

// Fetch the body and compute the PARITY sha256 for `rel`. Uses Playwright's
// APIRequestContext (the `request` fixture) so the network stack matches the
// rest of the suite. The sha is `parityShaForFile(rel, body)` — which, for the
// INJECTED admin shells (admin/index*.html + admin/reviews/*.html), normalizes
// the per-env `window.CMS_*` identity injection before hashing (fix #17) so the
// served preview/prod shell and the local source compare on MACHINERY, not on
// the injected identity. Every other file is hashed RAW (strict). `rel` MUST be
// the admin-relative path (the same key `localBundle()` uses), forward-slashed.
async function fetchBodyHash(request, url, rel) {
  const response = await request.fetch(url, { method: "GET" });
  const status = response.status();
  if (!response.ok()) {
    return { status, etag: null, sha: null };
  }
  const buf = await response.body();
  const sha = parityShaForFile(rel, buf);
  // ETag header (CloudFront forwards S3's ETag verbatim for un-edge-
  // cached responses); strip the surrounding quotes for clean compares.
  const etag = (response.headers().etag || "").replace(/^"|"$/g, "");
  return { status, etag, sha };
}

// Resolve the latest open PR number via the GitHub REST API. Uses the
// Playwright APIRequestContext (no `child_process` / `execFileSync`)
// so the spec stays read-only — a future @parity-tag lint (G3) bans
// `execFileSync` outright. Public-repo endpoint, no auth required;
// rate-limited to 60/hr unauthenticated, well above what one CI run
// consumes. If the call errors or returns an empty array, return null
// and the spec skips the preview comparison with a console note —
// the prod-side parity vs. local files still runs.
async function findLatestOpenPrNumber(request) {
  try {
    const response = await request.fetch(
      "https://api.github.com/repos/Adam-S-Daniel/adamdaniel.ai/pulls?state=open&sort=created&direction=desc&per_page=1",
      {
        method: "GET",
        headers: { Accept: "application/vnd.github+json" },
      },
    );
    if (!response.ok()) {
      console.log(
        `[admin-bundle-parity] GitHub API returned ${response.status()}; skipping preview-side comparison`,
      );
      return null;
    }
    const arr = await response.json();
    if (Array.isArray(arr) && arr.length && typeof arr[0].number === "number") {
      return arr[0].number;
    }
    return null;
  } catch (err) {
    console.log(
      `[admin-bundle-parity] GitHub API request failed (${err.message}); skipping preview-side comparison`,
    );
    return null;
  }
}

test.describe(
  "@parity admin bundle byte-parity",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ timeout: 120_000 });

    test.beforeEach(() => {});

    // Read every shipped admin source file once (sha + the index.html
    // manifest used as the version marker). Shared by both gates below.
    function localBundle() {
      const adminDir = path.join(__dirname, "..", "theme", "admin");
      const allFiles = listAdminFiles(adminDir);
      const files = allFiles.filter((p) => !isExcluded(p));
      const shaByRel = {};
      for (const rel of files) {
        try {
          // Use the forward-slashed rel as the parity key so isInjectedShell()
          // classifies `reviews/health.html` correctly on every platform; the
          // injected shells get their per-env window.CMS_* identity normalized
          // before hashing (fix #17), every other file is hashed RAW (strict).
          const relKey = rel.split(path.sep).join("/");
          shaByRel[rel] = parityShaForFile(relKey, fs.readFileSync(path.join(adminDir, rel)));
        } catch (_) {
          shaByRel[rel] = null;
        }
      }
      let indexHtml = null;
      try {
        indexHtml = fs.readFileSync(path.join(adminDir, MANIFEST_FILE), "utf8");
      } catch (_) {
        /* index.html missing locally → version marker indeterminate */
      }
      return { files, shaByRel, indexHtml };
    }

    // REQUIRED hard gate (fix #14): the PR's OWN preview bundle must
    // byte-match the local/source tree. A preview deploy whose bytes don't
    // match the PR is a broken preview build — the real per-PR risk, always
    // a hard fail (no bump excuse: it's the PR's own output). Skips cleanly
    // when there's no open PR / preview env.
    test("REQUIRED: the PR's preview bundle byte-matches the local source", async ({
      request,
    }) => {
      const { files, shaByRel } = localBundle();
      expect(files.length, "Expected at least one admin/ file after exclusions").toBeGreaterThan(0);

      const previewPr = await findLatestOpenPrNumber(request);
      const previewBase =
        previewPr !== null ? `https://preview-pr${previewPr}.adamdaniel.ai` : null;
      test.skip(
        !previewBase,
        "no open PR / preview env — nothing to gate (the bump-aware prod check still runs)",
      );
      console.log(`[admin-bundle-parity] REQUIRED gate: preview-pr${previewPr} vs. local source`);

      const failures = [];
      for (const rel of files) {
        const relUrl = rel.split(path.sep).join("/");
        const urlPath = `/${ADMIN_PREFIX}/${relUrl}`;
        const preview = await fetchBodyHash(request, `${previewBase}${urlPath}`, relUrl);
        const verdict = previewVsLocalVerdict(rel, preview, { sha: shaByRel[rel] });
        if (verdict.kind === "fail") failures.push(verdict.reason);
      }

      expect(
        failures,
        `Preview bundle does not match the PR source (${failures.length}) — a BROKEN ` +
          `PREVIEW BUILD. This is the PR's own deployed output; fix the preview deploy ` +
          `(it must serve exactly what's in theme/admin on this branch):\n  ${failures.join("\n  ")}`,
      ).toEqual([]);
    });

    // BUMP-AWARE prod check (fix #14): compare prod's served bundle version
    // (the index.html manifest sha) to the PR's source version. Different
    // version ⇒ a bump is in progress and prod legitimately lags → any
    // prod-vs-source byte mismatch is INFORMATIONAL. Same version ⇒ a byte
    // mismatch is REAL prod drift → HARD FAIL (preserves the original
    // prod-drift intent). Runs whether or not a PR is open.
    test("BUMP-AWARE: prod matches source, OR a same-version drift hard-fails", async ({
      request,
    }) => {
      const { files, shaByRel, indexHtml: localIndexHtml } = localBundle();
      expect(files.length, "Expected at least one admin/ file after exclusions").toBeGreaterThan(0);

      // Fetch prod's index.html (the version marker) first. Only its .status is
      // consumed here (the version comparison uses the RAW index.html text,
      // re-fetched below) — the parity sha is computed for completeness.
      const prodIndex = await fetchBodyHash(
        request,
        `${PROD_BASE}/${ADMIN_PREFIX}/${MANIFEST_FILE}`,
        MANIFEST_FILE,
      );
      // Re-fetch the prod index BODY as text for the manifest extraction. The
      // fetchBodyHash only kept the sha; do a tiny second GET to get the bytes
      // (one extra request; the marker file is small). 200 → text; else null.
      let prodIndexHtml = null;
      if (prodIndex.status === 200) {
        const r = await request.fetch(`${PROD_BASE}/${ADMIN_PREFIX}/${MANIFEST_FILE}`);
        if (r.ok()) prodIndexHtml = await r.text();
      }

      // The version marker (index.html) is itself an INJECTED shell, so the
      // served prod index carries the per-env window.CMS_* identity block while
      // the raw local source has none. Normalize BOTH before comparing versions
      // (fix #17), so "same bundle version" reflects the MACHINERY/manifest —
      // not the per-env identity (otherwise prod-served-with-block vs
      // local-source-without-block would ALWAYS read as a bump, defeating the
      // #14 same-version prod-drift HARD FAIL). The #14 fixtures carry no
      // injected block, so this normalization is a no-op for them.
      const versions = compareVersions(
        normalizeInjectedIdentity(prodIndexHtml),
        normalizeInjectedIdentity(localIndexHtml),
      );
      if (!versions.determinable) {
        console.log(
          `[admin-bundle-parity] version marker indeterminate (prod index ${prodIndex.status}, ` +
            `local index ${localIndexHtml ? "present" : "missing"}) → prod-vs-source mismatches ` +
            `treated as INFORMATIONAL; prod-drift at an unknown version is caught by canary-prod.`,
        );
      } else if (versions.sameVersion) {
        console.log(
          `[admin-bundle-parity] prod is at the SAME bundle version as this PR ` +
            `(${describeVersion(versions.local)}); any prod-vs-source byte mismatch is REAL DRIFT.`,
        );
      } else {
        console.log(
          `[admin-bundle-parity] BUMP IN PROGRESS: prod lags ${describeVersion(versions.prod)} -> ` +
            `${describeVersion(versions.local)}; prod-vs-source mismatches are INFORMATIONAL ` +
            `(will reconcile on deploy).`,
        );
      }

      const failures = [];
      const infos = [];
      for (const rel of files) {
        const relUrl = rel.split(path.sep).join("/");
        const urlPath = `/${ADMIN_PREFIX}/${relUrl}`;
        const prod = await fetchBodyHash(request, `${PROD_BASE}${urlPath}`, relUrl);
        const verdict = prodVsLocalVerdict(rel, prod, { sha: shaByRel[rel] }, versions);
        if (verdict.kind === "fail") failures.push(verdict.reason);
        else if (verdict.kind === "info") infos.push(verdict.reason);
      }

      if (infos.length) {
        console.log(
          `[admin-bundle-parity] informational prod-lag notes (${infos.length}):\n  ` +
            infos.join("\n  "),
        );
      }

      expect(
        failures,
        `Prod admin bundle DRIFT at the SAME version (${failures.length}) — prod's served ` +
          `bundle differs from source while its index.html manifest matches, so this is NOT a ` +
          `bump lag (someone hand-edited prod, or a deploy partially failed):\n  ${failures.join("\n  ")}`,
      ).toEqual([]);
    });
  },
);
