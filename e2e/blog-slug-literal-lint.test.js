// @lane: local — pure-fs grep over spec files; no browser, no network
// Lint: ban hard-coded `/blog/<slug>/` URLs in spec files.
//
// Background — PR #29 / #57 fix derived every blog slug at runtime from a
// `_posts/` glob. Reverting to literals creates a tripwire any time content
// gets edited: rename a post, six unrelated specs go red. The rule below
// catches the regression at lint time before it lands.
//
// Allowed forms:
//   1. A line carrying the comment `// allowed: literal slug used for
//      known fixture` (must appear on the same line OR the line above).
//   2. A file-scope pragma — the same `allowed: literal slug used for
//      known fixture` comment placed in the first 30 lines of the file.
//      Use this for specs that exercise URL-routing logic with synthetic
//      `/blog/foo/`-style inputs sprayed across many `test()` blocks.
//   3. A literal whose slug is the basename of a real `_posts/*.md` file
//      that the test explicitly references as a fixture target. We do NOT
//      auto-permit every existing post — a fixture has to be opted-in via
//      the comment, otherwise the lint would devolve into "any slug we
//      ship is fine", which defeats the point.
//
// Detection: regex `\bblog/[a-z0-9][a-z0-9-]{2,}/` scoped to `e2e/*.spec.js`.

const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const REPO_ROOT = path.join(__dirname, "..");
const SPEC_DIR = path.join(REPO_ROOT, "e2e");
const ALLOW_COMMENT = /allowed:\s*literal slug used for known fixture/i;
const SLUG_RE = /\bblog\/[a-z0-9][a-z0-9-]{2,}\//g;

function listSpecs() {
  return fs
    .readdirSync(SPEC_DIR)
    .filter((n) => n.endsWith(".spec.js"))
    .map((n) => path.join(SPEC_DIR, n));
}

test("found .spec.js files to scan (sanity)", () => {
  expect(listSpecs().length).toBeGreaterThan(0);
});

test("no hard-coded /blog/<slug>/ literals without an opt-in comment", () => {
  const offenders = [];
  for (const file of listSpecs()) {
    if (path.basename(file) === "blog-slug-literal-lint.test.js") continue;
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    // File-scope pragma: an `allowed:` comment in the header lifts the rule
    // for the whole file. Cap at 30 lines so a stale comment buried later
    // can't accidentally silence the lint.
    const filePragma = lines.slice(0, 30).some((l) => ALLOW_COMMENT.test(l));
    if (filePragma) continue;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip pure-comment lines — they often discuss URL shapes.
      if (/^\s*\/\//.test(line) || /^\s*\*/.test(line)) continue;
      // Strip line-end // comments before matching, but keep the comment
      // text available for the opt-in check.
      const codePart = line.replace(/\/\/.*$/, "");
      if (!SLUG_RE.test(codePart)) {
        SLUG_RE.lastIndex = 0;
        continue;
      }
      SLUG_RE.lastIndex = 0;
      const sameLineComment = ALLOW_COMMENT.test(line);
      const prevLineComment = i > 0 && ALLOW_COMMENT.test(lines[i - 1]);
      if (sameLineComment || prevLineComment) continue;
      const rel = path.relative(REPO_ROOT, file);
      offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
});
