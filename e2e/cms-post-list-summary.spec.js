// @lane: local — fs reads of the rendered _site/admin/config.yml + drives the local /admin shell
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

// Locks the posts-collection list summary template across all three Decap
// configs. The summary is what editors see in the Posts list view — the
// at-a-glance label for each entry. Without this, an unpublished post is
// visually indistinguishable from a published one in the list, so an editor
// scanning for drafts has to open each entry to check the `published`
// toggle.
//
// The template is shared verbatim between admin/config.yml (production /
// editorial-workflow), admin/config-local.yml (decap-server local backend),
// and admin/config-test.yml (test-repo backend driven by Playwright).
// Drift between the three would mean the local + test runs render a
// different list label than production — the kind of subtle divergence
// that audit-style YAML invariants exist to catch.
//
// The two ternary clauses cover the two non-overlapping draft-shaped
// states:
//
//   1. `published: false` AND no `publish_date` → " — DRAFT"
//      (this unit's contribution; surfaces the unpublished state).
//   2. `publish_date` set (regardless of `published`)  → " — Scheduled"
//      (pre-existing; flags posts the scheduled-publish workflow will
//      flip on at a future date).
//
// `published: true` with no `publish_date` renders bare (just the
// title) — the steady-state published case.

// SITE_ROOT-aware resolution. The summary template is asserted against the
// RENDERED Decap config the gem's render hook emits to
// `<site>/_site/admin/config.yml` during the local-lane build (the source
// `admin/config.yml` doesn't exist — only the `config.base.yml` template).
// The cross-config "shared verbatim across all three" check is meaningless
// in a consumer (config-local.yml / config-test.yml are platform-only test
// scaffolding, with config-test.yml never even rendered), so it's reduced to
// a single rendered-config assertion.
const REPO_ROOT = path.join(__dirname, "..");
const SITE_ROOT = process.env.SITE_ROOT || REPO_ROOT;
const RENDERED_CONFIG = path.join(SITE_ROOT, "_site", "admin", "config.yml");
const CONFIGS = [RENDERED_CONFIG];

// NO date token/filter — Decap's `summaryFormatter` (decap-cms-core
// formatters.js) computes the date via `parseDateFromEntry`, which runs
// PLAIN `dayjs(rawStoredString)` against our stored
// "YYYY-MM-DD HH:mm:ss ZZ" format; that space+offset form isn't
// ISO-8601, so dayjs falls back to native `new Date(string)` — Invalid
// on strict engines (WebKit/Safari/iOS). On parse failure `date` is
// `null`, and `compileStringTemplate` (decap-cms-lib-widgets
// stringTemplate.js) treats `date === null` as "date processing off":
// every {{year}}/{{month}}/{{day}} token silently compiles to '' instead
// of throwing (its SLUG_MISSING_REQUIRED_DATE throw is gated on
// `date !== null`) — every post rendered "Title (--)" on WebKit (issue
// #1042 lineage; its fix changed the failure mode from "INVALID DATE" to
// "(--)"). The `slug:` template survives the SAME parse failure only
// because `slugFormatter` falls back to `new Date(Date.now())` instead
// of `null` — same parser, different fallback. The date is rendered
// instead by admin/posts-list-enhance.js from the file slug's
// `YYYY-MM-DD-` prefix.
const EXPECTED_SUMMARY =
  "{{title}}" +
  "{{published | ternary('', ' — DRAFT')}}" +
  "{{publish_date | ternary(' — Scheduled', '')}}";

const DRAFT_CLAUSE = "{{published | ternary('', ' — DRAFT')}}";
const SCHEDULED_CLAUSE = "{{publish_date | ternary(' — Scheduled', '')}}";

function parseConfig(file) {
  return YAML.parse(fs.readFileSync(file, "utf8")) || {};
}

function findCollection(cfg, name) {
  return ((cfg && cfg.collections) || []).find((c) => c && c.name === name) || null;
}

// The collection's `summary:` template value — the string Decap renders
// per entry — or null when unset. Locking the value (not the YAML line
// bytes) is what keeps the three configs rendering an identical list
// label; quoting / indentation style is irrelevant to the result.
function summaryOf(collection) {
  return collection && collection.summary != null ? String(collection.summary) : null;
}

test.describe(
  "Decap CMS posts-list summary template",
  // Tagged @admin-read: reads admin/config*.yml + drives local /admin
  // shell, no GitHub writes — runs on chromium-desktop-3k +
  // webkit-iphone16 only. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.describe.configure({ mode: "serial" });

    // The rendered config only exists after the local Jekyll build + render
    // hook run; skip (rather than ENOENT-fail) when `_site` isn't built —
    // mirrors the sitemap.spec self-skip for the preview/prod lanes.
    test.beforeEach(() => {
      test.skip(
        !fs.existsSync(RENDERED_CONFIG),
        `${RENDERED_CONFIG} not built (run the local Jekyll build + render-decap-config.rb) — rendered-config summary check only runs in the local lane`,
      );
      // #33 — this whole describe is about the POSTS-list summary; a
      // single-page consumer that opts out of the posts collection via
      // cms.base_collections (v0.1.7) has no Posts list to label. Skip
      // precisely (keyed on the rendered config) when posts is absent;
      // unchanged on a full consumer (the fixture-site + adamdaniel.ai).
      test.skip(
        !cap.hasAdminCollection(SITE_ROOT, "posts"),
        'consumer opts out of the "posts" collection via cms.base_collections — skipping the Posts-list summary template (#33)',
      );
    });

    for (const configPath of CONFIGS) {
      const label = path.relative(SITE_ROOT, configPath);

      test(`${label}: posts.summary line equals the locked template verbatim`, () => {
        const posts = findCollection(parseConfig(configPath), "posts");
        expect(posts, "posts collection must exist").not.toBeNull();
        const summary = summaryOf(posts);
        expect(summary, "posts collection must declare a summary template").not.toBeNull();
        // Lock the rendered config's summary against the canonical template
        // verbatim. (The former cross-config "shared across all three" drift
        // lock is dropped in consumer mode — config-local.yml / config-test.yml
        // are platform-only test scaffolding.)
        expect(summary).toBe(EXPECTED_SUMMARY);
        // Date tokens/filters silently render '' / INVALID DATE on
        // WebKit (see the EXPECTED_SUMMARY comment) — guard against a
        // future edit re-adding either.
        expect(summary).not.toMatch(/\{\{\s*(year|month|day)\s*\}\}|\|\s*date\(/);
      });

      test(`${label}: posts.summary surfaces both DRAFT and Scheduled states`, () => {
        const posts = findCollection(parseConfig(configPath), "posts");
        const summary = summaryOf(posts);
        // The DRAFT clause is the new contribution (D3) — `published: false`
        // appends " — DRAFT" so editors see the state at a glance in the
        // Posts list. The Scheduled clause was already there; locking both
        // together prevents a future edit from regressing one in passing
        // while landing the other.
        expect(summary).toContain(DRAFT_CLAUSE);
        expect(summary).toContain(SCHEDULED_CLAUSE);
      });
    }
  },
);
