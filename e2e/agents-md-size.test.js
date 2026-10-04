// @lane: local — pure-fs lint. Keeps the repo-root AGENTS.md well under the
// byte limit at which Codex silently truncates project instructions.
//
// Codex reads AGENTS.md up to `project_doc_max_bytes` (32 KiB = 32,768 bytes by
// default) and drops the rest WITHOUT a warning, so whatever sits at the end of
// the file — this repo's own additions — is the part that disappears. On
// 2026-10-03 the file measured 32,097 bytes, 671 under that cut
// (cms-platform#538), and any one more rule would have fallen off the end.
//
// The budget is 28 KiB (28,672 bytes), 4 KiB below the cut — the target
// proposed on cms-platform#538. The headroom is for the part of the file this
// repo does not control: everything above `## Repo-specific additions` is the
// `_agent-guidance` managed block, rewritten by its sync. It was ~4.9 KB when
// this lint landed, and 4 KiB lets it nearly double before a sync could push
// this repo's own rules past the cut. A budget AT the cut would fail only once
// the damage is already possible.
//
// When this fails, do NOT raise the budget. Move detail into the matching
// `docs/*.md` file (AGENTS.md's "Deeper references" table names it) and leave
// a one-line rule plus a pointer — the pattern the rest of the file follows.
//
// Bytes, not characters: the limit is a UTF-8 byte count, and this file is
// full of multi-byte em dashes and arrows.
//
// PLATFORM-INTERNAL: on a consumer lane the harness sits at the site root, so
// `..` would resolve to the CONSUMER's AGENTS.md, which carries its own budget.
// Registered in PLATFORM_META_SPECS for that reason.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const AGENTS_MD = path.join(REPO_ROOT, "AGENTS.md");

// Codex's default `project_doc_max_bytes`.
const CODEX_TRUNCATION_BYTES = 32 * 1024;
// See the header for why 4 KiB of headroom.
const BUDGET_BYTES = 28 * 1024;

test.describe("AGENTS.md stays under its byte budget", () => {
  test("the budget leaves real headroom below Codex's truncation point", () => {
    expect(CODEX_TRUNCATION_BYTES - BUDGET_BYTES).toBeGreaterThanOrEqual(4 * 1024);
  });

  test(`AGENTS.md is at most ${BUDGET_BYTES} UTF-8 bytes`, () => {
    const bytes = fs.readFileSync(AGENTS_MD).length;
    expect(
      bytes,
      `AGENTS.md is ${bytes} bytes, over its ${BUDGET_BYTES}-byte budget ` +
        `(Codex silently truncates at ${CODEX_TRUNCATION_BYTES}). Do not raise the ` +
        "budget: move detail below `## Repo-specific additions` into the matching " +
        "docs/*.md file and leave a one-line rule plus a pointer. See this file's header.",
    ).toBeLessThanOrEqual(BUDGET_BYTES);
  });

  test("every docs/*.md file AGENTS.md points at exists", () => {
    // A pointer is the only trace a moved rule leaves in AGENTS.md, so a
    // pointer to a missing file loses the rule. A lexical token match is the
    // right tool here: a path inside backticks, not code shape. Only this
    // repo's half is checked: the managed block above the header names
    // `_agent-guidance`'s own docs.
    const full = fs.readFileSync(AGENTS_MD, "utf8");
    const header = full.indexOf("\n## Repo-specific additions\n");
    expect(header, "AGENTS.md lost its `## Repo-specific additions` header").toBeGreaterThan(-1);
    const src = full.slice(header);
    const named = [...new Set([...src.matchAll(/`(docs\/[\w./-]+\.md)`/g)].map((m) => m[1]))];
    expect(named.length, "AGENTS.md should point at its docs/ long forms").toBeGreaterThan(0);
    const missing = named.filter((rel) => !fs.existsSync(path.join(REPO_ROOT, rel)));
    expect(missing, "AGENTS.md points at docs that do not exist").toEqual([]);
  });
});
