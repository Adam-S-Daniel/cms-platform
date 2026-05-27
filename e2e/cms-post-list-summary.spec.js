// @lane: local — fs reads of admin/config*.yml + drives the local /admin shell
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

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
// `published: true` with no `publish_date` renders bare ("title (date)")
// — the steady-state published case.

const REPO_ROOT = path.join(__dirname, "..");
const CONFIGS = [
  path.join(REPO_ROOT, "admin/config.yml"),
  path.join(REPO_ROOT, "admin/config-local.yml"),
  path.join(REPO_ROOT, "admin/config-test.yml"),
];

// The date is rendered with Decap's parsed-date tokens
// {{year}}-{{month}}-{{day}} rather than `{{date | date('MMM D, YYYY')}}`.
// The `date(...)` summary filter runs bundled dayjs on the RAW stored
// string ("YYYY-MM-DD HH:mm:ss ZZ"); that space+offset form isn't
// ISO-8601, so dayjs falls back to native `new Date()` — Invalid on
// strict engines (WebKit/Safari/iOS), so every post rendered
// "INVALID DATE" there (issue #1042). {{year}}/{{month}}/{{day}} use the
// same parsed-date machinery as the `slug:` template (proven correct
// cross-engine; locked by cms-permalink-contract.spec.js).
const EXPECTED_SUMMARY =
  "{{title}} ({{year}}-{{month}}-{{day}})" +
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

    for (const configPath of CONFIGS) {
      const label = path.relative(REPO_ROOT, configPath);

      test(`${label}: posts.summary line equals the locked template verbatim`, () => {
        const posts = findCollection(parseConfig(configPath), "posts");
        expect(posts, "posts collection must exist").not.toBeNull();
        const summary = summaryOf(posts);
        expect(summary, "posts collection must declare a summary template").not.toBeNull();
        // The literal template is shared across all three configs — drift
        // between them would mean the local / test runs render a different
        // list label than production.
        expect(summary).toBe(EXPECTED_SUMMARY);
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
