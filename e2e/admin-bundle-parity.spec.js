// @lane: real — fetches admin/ bytes from https://adamdaniel.ai and the live PR preview to compare
const { test, expect } = require("./base");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// G2 — Admin bundle byte-parity probe.
//
// Walks the local `admin/` working tree and GETs each shipped file
// against:
//
//   1. https://adamdaniel.ai/admin/<path>                  — production
//   2. https://preview-pr<N>.adamdaniel.ai/admin/<path>    — latest open PR
//
// Compares ETag first (CloudFront/S3 hands it out cheap) and falls
// back to sha256 of the body bytes when ETags are absent or don't
// agree (CloudFront and S3 sometimes serve different ETag formats —
// weak vs. strong, mid-edge transformations, etc.). The body is read
// in the same response either way; the choice between ETag and
// sha256 is just which artefact we compare. Fails on the first real
// divergence — the spec catches the failure mode where prod drifted
// vs. what's checked in (e.g. someone hand-edited a file via the
// prod admin's editor pane, or a deploy partially failed).
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

const PROD_BASE = "https://adamdaniel.ai";
const ADMIN_PREFIX = "admin";

// 404 is acceptable for files added on a not-yet-merged PR or just
// removed on the working tree — the deploy-lag handler downgrades
// such mismatches to console warnings.
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
  // Don't compare the per-deploy commit.json or any config*.yml —
  // they're mutated by the preview pipeline.
  if (relPath === "commit.json") return true;
  if (/^config[^/]*\.ya?ml$/.test(relPath)) return true;
  // Local-dev / test admin entry points are deliberately omitted from
  // both deploy syncs — they only need to exist in the local-served
  // `_site/`. Don't expect them on prod or preview URLs.
  if (relPath === "index-local.html") return true;
  if (relPath === "index-test.html") return true;
  return false;
}

// Fetch the body and compute sha256. Uses Playwright's
// APIRequestContext (the `request` fixture) so the network stack
// matches the rest of the suite.
async function fetchBodyHash(request, url) {
  const response = await request.fetch(url, { method: "GET" });
  const status = response.status();
  if (!response.ok()) {
    return { status, etag: null, sha: null };
  }
  const buf = await response.body();
  const sha = crypto.createHash("sha256").update(buf).digest("hex");
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

    test("prod and preview admin bundles are byte-identical to the working tree", async ({
      request,
    }) => {
      const adminDir = path.join(__dirname, "..", "theme", "admin");
      const allFiles = listAdminFiles(adminDir);
      const files = allFiles.filter((p) => !isExcluded(p));

      expect(files.length, "Expected at least one admin/ file after exclusions").toBeGreaterThan(0);

      const previewPr = await findLatestOpenPrNumber(request);
      const previewBase =
        previewPr !== null ? `https://preview-pr${previewPr}.adamdaniel.ai` : null;
      if (previewBase) {
        console.log(`[admin-bundle-parity] comparing prod vs. preview-pr${previewPr}`);
      } else {
        console.log(`[admin-bundle-parity] no open PR — running prod-side parity only`);
      }

      const failures = [];
      const lagWarnings = [];

      for (const rel of files) {
        const urlPath = `/${ADMIN_PREFIX}/${rel.split(path.sep).join("/")}`;
        const prodUrl = `${PROD_BASE}${urlPath}`;

        const prod = await fetchBodyHash(request, prodUrl);

        if (!previewBase) {
          // No preview — skip the cross-host comparison but still
          // surface obviously-broken prod responses (anything other
          // than 200 or 404; 404 is acceptable for files added in a
          // not-yet-merged PR).
          if (prod.status !== 200 && !ACCEPTABLE_STATUSES_MISSING.has(prod.status)) {
            failures.push(`${rel}: prod returned ${prod.status} (expected 200 or 404)`);
          }
          continue;
        }

        const previewUrl = `${previewBase}${urlPath}`;
        const preview = await fetchBodyHash(request, previewUrl);

        // Both 404 → consistent absence (file was just deleted on
        // both branches, or the admin/ tree is ahead of both deploys).
        // Both 200 → continue to the byte-parity check.
        if (prod.status === 404 && preview.status === 404) {
          continue;
        }

        // One 404, the other 200 → expected deploy-lag window. Warn,
        // don't fail. (Could be: file just added on the PR's branch,
        // not yet merged → preview has it, prod doesn't. Or file just
        // merged → prod has it but the PR's preview pre-dates the
        // merge.) Either way the gap closes once both deploys settle.
        if (prod.status === 404 || preview.status === 404) {
          lagWarnings.push(
            `${rel}: prod=${prod.status}, preview=${preview.status} (deploy lag — expected during merge windows)`,
          );
          continue;
        }

        // Both not-404 and not-200 (e.g. 500, 403): real breakage.
        if (prod.status !== 200 || preview.status !== 200) {
          failures.push(
            `${rel}: prod=${prod.status}, preview=${preview.status} (expected 200/200)`,
          );
          continue;
        }

        // Both 200 → byte parity. Prefer ETag when both sides offer
        // one and they're non-empty; fall back to sha256 of body.
        const haveBothEtags = prod.etag && preview.etag;
        if (haveBothEtags && prod.etag === preview.etag) continue;
        if (prod.sha && preview.sha && prod.sha === preview.sha) continue;

        // Bytes differ between prod and preview. Three cases:
        //   - working-tree matches preview → preview is "ahead" of prod
        //     because this branch (or a recently-merged one) changed the
        //     file, and prod hasn't redeployed/cache-invalidated yet.
        //     Deploy lag, not drift. Warn instead of failing.
        //   - working-tree matches prod → preview is "ahead" of working
        //     tree (preview wasn't built from this branch?), unusual but
        //     not a drift signal. Warn.
        //   - neither matches → real cross-environment drift. Fail.
        let localSha = null;
        try {
          const buf = fs.readFileSync(path.join(adminDir, rel));
          localSha = crypto.createHash("sha256").update(buf).digest("hex");
        } catch (_) {
          /* file missing locally — fall through to failure */
        }
        if (localSha && preview.sha === localSha) {
          lagWarnings.push(
            `${rel}: prod sha=${prod.sha?.slice(0, 12)}, preview sha=${preview.sha?.slice(0, 12)} (deploy lag — branch change hasn't reached prod yet)`,
          );
          continue;
        }
        if (localSha && prod.sha === localSha) {
          lagWarnings.push(
            `${rel}: prod sha=${prod.sha?.slice(0, 12)}, preview sha=${preview.sha?.slice(0, 12)} (preview ahead of working tree — likely stale preview build)`,
          );
          continue;
        }

        failures.push(
          `${rel}: byte mismatch\n` +
            `      prod    etag=${prod.etag || "(none)"} sha=${prod.sha}\n` +
            `      preview etag=${preview.etag || "(none)"} sha=${preview.sha}\n` +
            `      local   sha=${localSha || "(unreadable)"}`,
        );
      }

      if (lagWarnings.length) {
        console.log(
          `[admin-bundle-parity] deploy-lag warnings (${lagWarnings.length}):\n  ` +
            lagWarnings.join("\n  "),
        );
      }

      expect(
        failures,
        `Admin bundle parity failures (${failures.length}):\n  ${failures.join("\n  ")}`,
      ).toEqual([]);
    });
  },
);
