// @lane: local — pure-fs invariants on the #1042 admin posts changes; no browser
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// Locks the issue #1042 ("Improve admin UI related to posts") wiring so a
// future edit can't silently regress it:
//
//   1. The "View page on site:" banner (admin/live-url-banner.js) — a
//      past change (#184) deleted it, leaving the editor with NO link to
//      the post. It's restored and must load from all three index shells
//      in derive → banner → override order, and be excluded from the
//      native-anchor hide so native-preview-href.js can't swallow it.
//   2. admin/posts-list-enhance.js — the custom Posts-list dashboard.
//      Must load from all three shells, AUGMENT (never replace) Decap's
//      `a[href*="#/collections/posts/entries/"]` cards so every existing
//      e2e selector keeps resolving, hide fixtures NON-destructively
//      (reorder-to-end, not removeChild) so `.first()`-click specs still
//      land on a visible real post, and CSS-hide only the E2E Quick-add
//      item.
//   3. The posts `summary:` no longer uses the dayjs `date(...)` filter
//      that rendered "INVALID DATE" on WebKit; the `Automated tests`
//      view_filter + hidden `test_fixture` field exist in all three
//      configs; the canary _posts carry `test_fixture: true` and the
//      real post does not.
//
// Pure-fs + deterministic on purpose (mirrors cms-config.spec.js): the
// runtime behaviour is exercised by the existing cms-smoke /
// manual-walkthrough specs, which still click a list card with this
// script active.

const REPO_ROOT = path.join(__dirname, "..");
const ADMIN = path.join(REPO_ROOT, "admin");
const INDEX_FILES = ["index.html", "index-local.html", "index-test.html"].map((f) =>
  path.join(ADMIN, f),
);
const CONFIGS = ["config.yml", "config-local.yml", "config-test.yml"].map((f) =>
  path.join(ADMIN, f),
);

const read = (p) => fs.readFileSync(p, "utf8");
const scriptIdx = (html, file) => {
  const re = new RegExp(`<script[^>]+src=["']${file.replace(/[.]/g, "\\.")}["'][^>]*>`);
  const m = re.exec(html);
  return m ? m.index : -1;
};

test.describe("Issue #1042 — admin posts UI", () => {
  test.describe.configure({ mode: "serial" });

  // ── 1. Live-URL banner restored + correctly ordered ──────────────
  test("admin/live-url-banner.js exists and renders the testable anchor", () => {
    const p = path.join(ADMIN, "live-url-banner.js");
    expect(
      fs.existsSync(p),
      "admin/live-url-banner.js must exist (it was deleted in #184; #1042 restores it)",
    ).toBe(true);
    const src = read(p);
    expect(
      /\(\s*function\s*\(\s*\)\s*\{[\s\S]+\}\s*\)\s*\(\s*\)\s*;?/.test(src),
      "must be a self-contained IIFE",
    ).toBe(true);
    expect(src).toContain('id="cms-live-url-banner-link"');
    expect(src).toContain('data-testid="cms-live-url-banner-link"');
    // It must consume the single source of truth, not re-derive URLs.
    expect(src).toMatch(/window\.LiveURL/);
  });

  for (const idx of INDEX_FILES) {
    const rel = path.relative(REPO_ROOT, idx);
    test(`${rel}: loads derive → banner → override → posts-list-enhance`, () => {
      const html = read(idx);
      const derive = scriptIdx(html, "live-url-derive.js");
      const banner = scriptIdx(html, "live-url-banner.js");
      const override = scriptIdx(html, "native-preview-href.js");
      const enhance = scriptIdx(html, "posts-list-enhance.js");
      expect(derive, `${rel} must load live-url-derive.js`).toBeGreaterThan(-1);
      expect(banner, `${rel} must load live-url-banner.js (restored #1042)`).toBeGreaterThan(-1);
      expect(override, `${rel} must load native-preview-href.js`).toBeGreaterThan(-1);
      expect(enhance, `${rel} must load posts-list-enhance.js (#1042)`).toBeGreaterThan(-1);
      // derive defines window.LiveURL; the banner consumes it on first
      // render — derive MUST precede the banner, banner MUST precede the
      // native override (the historical, now-locked, load order).
      expect(
        derive < banner,
        `${rel}: live-url-derive.js must load before live-url-banner.js`,
      ).toBe(true);
      expect(
        banner < override,
        `${rel}: live-url-banner.js must load before native-preview-href.js`,
      ).toBe(true);
    });
  }

  test("native-preview-href.js excludes the restored banner anchor", () => {
    const src = read(path.join(ADMIN, "native-preview-href.js"));
    // Without this, the toolbar-anchor hide could swallow the banner
    // link (it's the same target=_blank rel=noopener shape).
    expect(src).toContain('"cms-live-url-banner-link"');
  });

  // ── 2. posts-list-enhance.js contract ────────────────────────────
  test("posts-list-enhance.js augments in place and hides fixtures non-destructively", () => {
    const src = read(path.join(ADMIN, "posts-list-enhance.js"));
    expect(
      /\(\s*function\s*\(\s*\)\s*\{[\s\S]+\}\s*\)\s*\(\s*\)\s*;?/.test(src),
      "must be a self-contained IIFE",
    ).toBe(true);
    expect(src).toMatch(/__postsListEnhanceInstalled/);
    // AUGMENT, not replace: it must select Decap's entry anchors (so
    // every existing `a[href*="…/entries/"]` spec selector still works)
    // and must NOT remove cards from the DOM.
    expect(src).toContain('a[href*="#/collections/posts/entries/"]');
    expect(
      src,
      "must not removeChild/remove() entry cards — Decap re-mount fight + breaks .first()-click specs",
    ).not.toMatch(/\.(removeChild|remove)\(/);
    // Non-destructive default-hide = reorder fixtures to the end.
    expect(src).toMatch(/data-cms-ple-fixture/);
    expect(src).toMatch(/appendChild/);
    // Reuses the established Decap operator-token pattern, no new auth.
    expect(src).toContain('localStorage.getItem("decap-cms-user")');
    // Quick-add hide is text-scoped to the e2e collection only.
    expect(src).toContain("E2E Canary");
    expect(src).toMatch(/E2E TEST FIXTURES/);
    // Manual refresh affordance (issue #1042 ask).
    expect(src).toMatch(/cms-ple-refresh/);
  });

  test("fixture detection matches the canary slugs, not the real post", () => {
    // Lock the intended classification independent of the source: dated
    // e2e canary slugs are fixtures; a normal post is not. Includes the
    // ephemeral per-run prod-loop posts (#1771 step 4) — they are created +
    // deleted within a run, never committed, but a mid-run Posts list must
    // still classify them as fixtures and default-hide them.
    const FIXTURE_SLUG_RE = /^\d{4}-\d{2}-\d{2}-e2e-/i;
    for (const slug of [
      "2024-01-02-e2e-unpublish-canary",
      "2099-12-31-e2e-prod-mutate-1779999999999",
      "2099-12-31-e2e-media-roundtrip-1779999999999",
    ]) {
      expect(FIXTURE_SLUG_RE.test(slug), `${slug} must be detected as a fixture`).toBe(true);
    }
    expect(
      FIXTURE_SLUG_RE.test("2026-05-12-introducing-gha-bench"),
      "a real post must NOT be detected as a fixture",
    ).toBe(false);
    // The regex above must match the one shipped in the script.
    const src = read(path.join(ADMIN, "posts-list-enhance.js"));
    expect(src).toContain("/^\\d{4}-\\d{2}-\\d{2}-e2e-/i");
  });

  // ── 3. Config + canary invariants ────────────────────────────────
  for (const cfg of CONFIGS) {
    const rel = path.relative(REPO_ROOT, cfg);
    test(`${rel}: INVALID-DATE fix + Automated tests filter + test_fixture field`, () => {
      const yml = read(cfg);
      // The dayjs `date(...)` summary filter is the INVALID DATE bug.
      expect(yml, `${rel} must not reintroduce the date(...) summary filter`).not.toMatch(
        /summary:.*date\(/,
      );
      expect(yml).toMatch(/summary:\s*"\{\{title\}\} \(\{\{year\}\}-\{\{month\}\}-\{\{day\}\}\)/);
      // `Automated tests` view_filter keyed off test_fixture.
      expect(yml).toMatch(/-\s*label:\s*Automated tests/);
      expect(yml).toMatch(/field:\s*test_fixture/);
      // Hidden, non-editor-facing marker field.
      expect(yml).toMatch(/-\s*name:\s*test_fixture[\s\S]*?widget:\s*hidden/);
    });
  }

  test("canary _posts carry test_fixture: true; the real post does not", () => {
    const postsDir = path.join(REPO_ROOT, "_posts");
    // Only the toggle-only unpublish canary is a PERSISTENT committed
    // `_posts/` fixture now: #1771 step 4 retired the prod-mutate +
    // media canaries for EPHEMERAL per-run posts (created + deleted within
    // a run, never committed). The ephemeral posts are ALSO born with
    // `test_fixture: true` — locked in e2e/prod-mutate-fixture.test.js
    // ("the post is BORN published, noindex, sitemap:false, test_fixture").
    for (const f of ["2024-01-02-e2e-unpublish-canary.md"]) {
      const fm = read(path.join(postsDir, f));
      expect(
        fm,
        `${f} must be flagged test_fixture: true so the Automated tests filter and the list default-hide catch it`,
      ).toMatch(/^test_fixture:\s*true\s*$/m);
    }
    // Spot-check a real post is not falsely flagged (guards a future
    // copy-paste of the canary frontmatter into a real post).
    const real = path.join(postsDir, "2026-05-12-introducing-gha-bench.md");
    if (fs.existsSync(real)) {
      expect(read(real)).not.toMatch(/^test_fixture:\s*true\s*$/m);
    }
  });
});

// ── Preview/PR link relabel + view-published-changes + the
//    "Check for Preview" root-cause fix ────────────────────────────
//
// Locks the follow-up admin changes so a future edit can't silently
// regress them (pure-fs, same lane as the suite above):
//
//   - posts-list-enhance.js renames the bare "preview-pr<N>" /
//     "PR #<N>" links to "preview draft" / "view draft changes",
//     points the change links at the GitHub Files-changed diff, and
//     adds "view published changes" (the merged PR's diff) gated on a
//     post actually being live on main and ordered before the draft
//     links;
//   - live-url-banner.js swaps the host to the per-PR preview env for
//     an unmerged editorial-workflow draft (the reported prod-404);
//   - deploy-preview.yml publishes a `deploy/preview` commit status
//     and admin/config*.yml pin `backend.preview_context` to it —
//     together the actual fix for the editor's perpetual
//     "Check for Preview" (decap-cms 3.12.2's github backend reads a
//     commit status, never the GitHub Deployment we already register).
test.describe("Admin preview/PR links + Check-for-Preview fix", () => {
  const PLE = path.join(ADMIN, "posts-list-enhance.js");
  const BANNER = path.join(ADMIN, "live-url-banner.js");
  const WF = path.join(REPO_ROOT, ".github", "workflows", "deploy-preview.yml");

  test("posts-list-enhance.js: relabelled links, diff URLs, view-published-changes", () => {
    const src = read(PLE);
    // New human labels.
    expect(src).toContain("preview draft");
    expect(src).toContain("view draft changes");
    expect(src).toContain("view published changes");
    // Old bare labels gone (distinctive source fragments) so a
    // regression can't silently restore them.
    expect(src, 'the bare "preview-pr<N>" link label was renamed').not.toContain(">preview-pr");
    expect(src, 'the bare "PR #<N>" link label was renamed').not.toContain(">PR #");
    // Both change links resolve to the GitHub Files-changed diff.
    expect(src, "draft-changes link must be the PR /files diff").toMatch(
      /esc\(pr\.url\)[\s\S]{0,40}\/files/,
    );
    expect(src, "published-changes link must be the PR /files diff").toMatch(
      /esc\(publishedPr\.url\)[\s\S]{0,40}\/files/,
    );
    // preview-draft link still targets the per-PR preview host.
    expect(src).toContain("https://preview-pr");
    // Published PR derived from the last main commit's PR — one
    // batched GraphQL query, not a per-row call.
    expect(src).toContain("associatedPullRequests");
    expect(src).toMatch(/var publishedPr = le && le\.pr/);
    // Order: "view published changes" renders BEFORE "preview draft"
    // (bits are pushed in source order).
    expect(
      src.indexOf("view published changes"),
      '"view published changes" must be pushed before "preview draft"',
    ).toBeLessThan(src.indexOf("preview draft"));
    // Gated on a merged PR existing — an unpublished draft (no main
    // history → no le.pr) must not show "view published changes".
    const block = src.slice(src.indexOf("var publishedPr"), src.indexOf("var pr ="));
    expect(block).toMatch(/if \(publishedPr\)/);
  });

  test("live-url-banner.js: preview-aware origin for unmerged drafts", () => {
    const src = read(BANNER);
    // Locked banner contract still holds.
    expect(src).toContain('id="cms-live-url-banner-link"');
    expect(src).toContain('data-testid="cms-live-url-banner-link"');
    expect(src).toMatch(/window\.LiveURL/);
    // Swaps host to the per-PR preview env when the open entry has an
    // editorial-workflow PR.
    expect(src).toMatch(/preview-pr["']\s*\+\s*n\s*\+\s*["']\.adamdaniel\.ai/);
    expect(src).toContain("/pulls?state=open");
    // Same operator-token auth as the rest of the admin (no new
    // surface); reuses posts-list-enhance's cache when warm.
    expect(src).toContain('localStorage.getItem("decap-cms-user")');
    expect(src).toContain("cms-ple-remote-cache-v1");
    // Degrade-safe: the published===false placeholder is untouched, so
    // cms-link-crawler's known-bug allowlist still holds.
    expect(src).toContain("Not yet published.");
  });

  test("deploy-preview.yml: publishes the deploy/preview commit status", () => {
    const wf = read(WF);
    expect(
      wf,
      "createCommitStatus is the github-backend deploy-preview signal Decap reads",
    ).toContain("createCommitStatus");
    expect(wf).toMatch(/context:\s*['"]deploy\/preview['"]/);
    expect(wf).toMatch(/state:\s*['"]success['"]/);
    // Needs the statuses:write scope to post it.
    expect(wf, "statuses:write scope is required to set a commit status").toMatch(
      /^\s*statuses:\s*write\s*$/m,
    );
    // Set on the PR head SHA (the ref Decap's getStatuses queries).
    expect(wf).toMatch(/PR_HEAD_SHA:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/);
  });

  for (const cfg of CONFIGS) {
    const rel = path.relative(REPO_ROOT, cfg);
    test(`${rel}: backend.preview_context pins deploy/preview`, () => {
      expect(
        read(cfg),
        `${rel} must pin backend.preview_context so Decap matches the deploy-preview.yml commit status`,
      ).toMatch(/^\s*preview_context:\s*deploy\/preview\s*$/m);
    });
  }
});
