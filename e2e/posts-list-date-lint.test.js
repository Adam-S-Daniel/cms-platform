// @lane: local — pure-fs lint on the posts-list summary/date-rendering fix
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

// Locks the "(--)" fix (issue #1042 lineage) so a future edit can't
// silently regress it.
//
// Decap's `summaryFormatter` parses the RAW stored space+offset date
// string ("YYYY-MM-DD HH:mm:ss ZZ") with plain `dayjs()` (no format
// string); that fails dayjs's ISO fast-path and falls back to native
// `new Date(string)`, which is Invalid on WebKit/Safari/iOS. On parse
// failure the formatter's `date` is `null`, and Decap's
// `compileStringTemplate` treats `date === null` as "date processing
// off" — every {{year}}/{{month}}/{{day}} token silently compiles to ''
// (the missing-date throw is gated on `date !== null`, so it never
// fires). Net result: "Title (--)" for every post in the Posts list on
// WebKit — observed live on Safari, reported 2026-07-10. The fix drops
// every date token/filter from the `summary:` template and instead
// renders the date in admin/posts-list-enhance.js from the on-disk file
// slug's `YYYY-MM-DD-` prefix (a pure string op — engine-proof).

const REPO_ROOT = path.join(__dirname, "..");
const CONFIGS = ["config.base.yml", "config-local.base.yml", "config-test.yml"].map((f) =>
  path.join(REPO_ROOT, "theme", "admin", f),
);

const EXPECTED_SUMMARY =
  "{{title}}" +
  "{{published | ternary('', ' — DRAFT')}}" +
  "{{publish_date | ternary(' — Scheduled', '')}}";

function findCollection(cfg, name) {
  return ((cfg && cfg.collections) || []).find((c) => c && c.name === name) || null;
}

function summaryOf(collection) {
  return collection && collection.summary != null ? String(collection.summary) : null;
}

test.describe("posts-list summary date fix — source config lint", () => {
  test("all three SOURCE configs declare the identical, verbatim summary template", () => {
    for (const configPath of CONFIGS) {
      const rel = path.relative(REPO_ROOT, configPath);
      const cfg = YAML.parse(fs.readFileSync(configPath, "utf8"));
      const posts = findCollection(cfg, "posts");
      expect(posts, `${rel}: posts collection must exist`).not.toBeNull();
      const summary = summaryOf(posts);
      expect(summary, `${rel}: posts.summary must equal the locked template verbatim`).toBe(
        EXPECTED_SUMMARY,
      );
    }
  });

  test("the summary carries no date token / filter (they break on WebKit)", () => {
    for (const configPath of CONFIGS) {
      const rel = path.relative(REPO_ROOT, configPath);
      const src = fs.readFileSync(configPath, "utf8");
      const m = /summary:\s*"([^"]*)"/.exec(src);
      expect(m, `${rel}: could not locate a summary: line`).not.toBeNull();
      expect(
        m[1],
        `${rel}: summary must not contain a {{year}}/{{month}}/{{day}} token or a ` +
          "| date(...) filter — both silently render '' / INVALID DATE on WebKit " +
          "(Decap's summaryFormatter → null date → compileStringTemplate skip)",
      ).not.toMatch(/\{\{\s*(year|month|day)\s*\}\}|\|\s*date\(/);
    }
  });

  test("posts-list-enhance.js derives the post date from the file slug prefix", () => {
    const src = fs.readFileSync(
      path.join(REPO_ROOT, "theme", "admin", "posts-list-enhance.js"),
      "utf8",
    );
    expect(
      src,
      "must derive the date from the YYYY-MM-DD- slug prefix — the engine-proof source",
    ).toContain("/^(\\d{4}-\\d{2}-\\d{2})-/");
    expect(src, "must expose the derived date as postDate on the card object").toContain(
      "postDate",
    );
  });
});
