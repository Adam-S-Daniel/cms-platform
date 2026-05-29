/*
 * Auto-resolve newline-only merge conflicts on Decap-opened CMS PRs.
 *
 * Why this exists
 * ---------------
 * Decap CMS 3.x's markdown widget round-trips bodies through Slate.
 * Slate's serializer doubles every soft line wrap inside a paragraph
 * (`\n` → `\n\n`) and triples paragraph breaks (`\n\n` → `\n\n\n\n`),
 * also eating the blank line between the frontmatter `---` and the
 * first body paragraph. When a sibling cleanup PR (the publish-loop
 * harness safety-net at `e2e/cms-publish-loop.spec.js:487-520`) has
 * already merged a canonical baseline to main, the still-open Decap
 * editorial PR conflicts with main even though both sides reduce to
 * the same canonical form. Without intervention the PR sits as
 * "dirty / conflicting" indefinitely — see PR #882.
 *
 * The primary fix (`admin/config.yml` widget: markdown → widget: text,
 * landed in the same change as this script) prevents the Slate
 * round-trip on the e2e collection. This resolver is belt-and-suspenders
 * for the entire CMS path-allowlist: any future regression — in any
 * collection — that produces a pure-newline-mangling diff degrades to
 * "auto-close the PR" instead of leaving a stuck merge state.
 *
 * Behavior
 * --------
 *   1. Pre-flight gates: PR state == open, mergeable_state == dirty,
 *      head ref matches HEAD_REF_ALLOWLIST, author matches
 *      AUTHOR_ALLOWLIST, head repo == base repo (no forks).
 *   2. Idempotency: comment with marker
 *      `<!-- key:<base-sha>:<head-sha> -->` exists ⇒ skip.
 *   3. Path allowlist: every changed file path must match
 *      PATH_ALLOWLIST. Any non-allowed path ⇒ abort with comment.
 *   4. Per-file equivalence: fetch base and head bytes for each file;
 *      a markdown code fence on either side ⇒ abort; canonical-collapse
 *      mismatch ⇒ abort.
 *   5. All files pass ⇒ post a sticky comment and close the PR. The
 *      diff is purely newline-mangling and main already has the
 *      canonical content, so closing loses no real intent. Forcing a
 *      rebase here would result in an empty diff PR — close is
 *      simpler and lower-risk.
 *
 * Anything outside the happy path leaves the PR untouched with a
 * sticky comment explaining why human review is needed. The same
 * sticky-comment marker doubles as the idempotency key.
 *
 * Required env:
 *   GH_TOKEN     CMS_E2E_PAT (not GITHUB_TOKEN; we don't push, but
 *                state changes need a user-scoped token for downstream
 *                workflows to fire on `pull_request: closed` events)
 *   GH_REPO      e.g. Adam-S-Daniel/adamdaniel.ai
 *   PR_NUMBER    the PR to inspect
 *   DRY_RUN      "true" ⇒ log decisions but make no writes
 */

"use strict";

// Path allowlist — any changed file in the PR must match one of these.
// Mirrors the CMS-managed collections in admin/config.yml.
const PATH_ALLOWLIST = [
  /^_e2e\/canary-[a-z]+\.md$/, // canary-post.md, canary-page.md, canary-project.md
  /^_e2e\/canary-delete-\d+\.md$/, // cms-delete-published.spec.js throw-away fixtures
  /^_posts\/.+\.md$/, // blog
  /^pages\/.+\.md$/, // static pages (note: pages/, not _pages/ — see admin/config.yml)
  /^_projects\/.+\.md$/, // projects
  /^_tags\/.+\.md$/, // tag descriptions
];

// Head-ref allowlist — only resolve PRs whose branch is from the CMS
// editorial workflow or the test harness's fixture path.
const HEAD_REF_ALLOWLIST = [
  /^cms\/e2e\//, // Decap editorial PRs for the e2e collection
  /^cms\/e2e-fixture\//, // seedFixtureViaPr branches
  /^cms\/posts\//, // Decap editorial PRs for posts
  /^cms\/pages\//, // Decap editorial PRs for pages
  /^cms\/projects\//, // Decap editorial PRs for projects
  /^cms\/tags\//, // Decap editorial PRs for tags
];

// Author allowlist — PRs from any other actor are out of scope.
const AUTHOR_ALLOWLIST = new Set([
  "decap-cms[bot]",
  "Adam-S-Daniel", // the OAuth shim and CMS_E2E_PAT commits land as this user
]);

const COMMENT_MARKER = "<!-- auto-resolve-newline-conflict-bot -->";

/**
 * Collapse every run of `\n` to a single `\n`. Two strings are
 * "newline-equivalent" iff their canonical forms match.
 *
 * Covers all three Slate round-trip transforms observed in PR #882:
 *   - `\n`   → `\n\n`     (soft wrap → paragraph break)
 *   - `\n\n` → `\n\n\n\n` (paragraph break → triple break)
 *   - `\n\n` → `\n`       (frontmatter-to-body separator eaten)
 *
 * The loose form (collapse ALL runs of `\n`) is deliberate: the
 * frontmatter-eating case requires `\n\n` and `\n` to compare equal,
 * which the tighter `\n\n+` → `\n\n` form would reject.
 */
function canonical(s) {
  return s.replace(/\n+/g, "\n");
}

function isPathAllowed(p) {
  return PATH_ALLOWLIST.some((r) => r.test(p));
}

function isHeadRefAllowed(ref) {
  return HEAD_REF_ALLOWLIST.some((r) => r.test(ref));
}

function isAuthorAllowed(login) {
  return AUTHOR_ALLOWLIST.has(login);
}

// Markdown code fences may contain intentionally-blank lines (e.g., a
// shell snippet with paragraph breaks between commands). Canonical
// collapse would silently equate them with their drift-doubled version,
// so we hard-fail when a fence is anywhere in either side's bytes.
function hasCodeFence(text) {
  return /(?:```|~~~)/.test(text);
}

function idempotencyKey(baseSha, headSha) {
  return `<!-- key:${baseSha}:${headSha} -->`;
}

async function gh(endpoint, opts = {}) {
  const url = endpoint.startsWith("https://") ? endpoint : `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `token ${process.env.GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "auto-resolve-newline-conflict-bot",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const err = new Error(
      `GH API ${opts.method || "GET"} ${endpoint} → ${res.status}: ${body.slice(0, 500)}`,
    );
    err.status = res.status;
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function fetchFileAtRef(repo, ref, path) {
  try {
    const r = await gh(`/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`);
    if (Array.isArray(r) || r.type !== "file") return null;
    return Buffer.from(r.content, "base64").toString("utf8");
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function fetchComments(repo, prNumber) {
  return gh(`/repos/${repo}/issues/${prNumber}/comments?per_page=100`);
}

async function postComment(repo, prNumber, body) {
  return gh(`/repos/${repo}/issues/${prNumber}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
    headers: { "Content-Type": "application/json" },
  });
}

async function closePr(repo, prNumber) {
  return gh(`/repos/${repo}/pulls/${prNumber}`, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed" }),
    headers: { "Content-Type": "application/json" },
  });
}

function formatAbortComment(idemKey, reasons) {
  return [
    COMMENT_MARKER,
    idemKey,
    "",
    "**Auto-resolver: cannot close this PR.**",
    "",
    "The newline-only auto-resolver inspected this conflicting PR and found one or more reasons to leave it for human review:",
    "",
    ...reasons.map((r) => `- ${r}`),
    "",
    "<details><summary>What does this resolver do?</summary>",
    "",
    "Decap CMS's markdown widget used to round-trip bodies through Slate, which mangled newlines. When a sibling cleanup PR landed a canonical baseline to main, the still-open Decap PR's mangled body conflicted with main even though both sides canonical-collapse to identical content. This resolver detects that case and closes such PRs automatically.",
    "",
    "If the diff *isn't* pure-newline-mangling — i.e. there's a real content change — the resolver aborts (as it just did here).",
    "",
    "Source: [`scripts/auto-resolve-newline-conflict.js`](../blob/main/scripts/auto-resolve-newline-conflict.js)",
    "</details>",
  ].join("\n");
}

function formatCloseComment(idemKey, paths) {
  return [
    COMMENT_MARKER,
    idemKey,
    "",
    "**Auto-closing: this PR's entire diff is newline-only mangling.**",
    "",
    "Every changed file's canonical-collapse form matches main exactly, so the PR contains no meaningful content delta. Main already has the canonical bytes. Closing.",
    "",
    "Files inspected:",
    ...paths.map((p) => `- \`${p}\``),
    "",
    "<details><summary>What does this resolver do?</summary>",
    "",
    "Decap CMS's markdown widget used to round-trip bodies through Slate, which doubled every soft line wrap on save (`\\n` → `\\n\\n`, `\\n\\n` → `\\n\\n\\n\\n`, blank-after-`---` eaten). The publish-loop spec's UI cleanup typed the canonical baseline body through that field, so the published file disagreed with the API-path baseline that the harness safety-net writes — leaving conflicting `cms/e2e/canary-*` PRs (PR #882).",
    "",
    'The primary fix switched the e2e collection body to `widget: text` (plain textarea, no round-trip). This resolver is belt-and-suspenders for the wider CMS path allowlist: any future regression that produces a pure-newline diff degrades to "auto-close" instead of "perpetually stuck".',
    "",
    "If this close was incorrect, reopen the PR and add a comment explaining the intent.",
    "",
    "Source: [`scripts/auto-resolve-newline-conflict.js`](../blob/main/scripts/auto-resolve-newline-conflict.js)",
    "</details>",
  ].join("\n");
}

async function run({ repo, prNumber, dryRun, log }) {
  log(`PR #${prNumber} in ${repo} (dry_run=${dryRun})`);

  const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);

  if (pr.state !== "open") {
    log(`skip: PR state is ${pr.state}`);
    return { outcome: "skip", reason: `state=${pr.state}` };
  }
  // PRs surface mergeable_state asynchronously; the first call after a
  // push may return `unknown`. Caller (workflow) should retry; here we
  // exit cleanly.
  if (pr.mergeable_state === "unknown") {
    log(`skip: mergeable_state is unknown (GitHub still computing)`);
    return { outcome: "skip", reason: "mergeable_state=unknown" };
  }
  if (pr.mergeable_state !== "dirty") {
    log(`skip: mergeable_state is ${pr.mergeable_state} (only resolving dirty)`);
    return { outcome: "skip", reason: `mergeable_state=${pr.mergeable_state}` };
  }
  if (!isHeadRefAllowed(pr.head.ref)) {
    log(`skip: head ref '${pr.head.ref}' not in HEAD_REF_ALLOWLIST`);
    return { outcome: "skip", reason: `head-ref=${pr.head.ref}` };
  }
  if (!isAuthorAllowed(pr.user.login)) {
    log(`skip: author '${pr.user.login}' not in AUTHOR_ALLOWLIST`);
    return { outcome: "skip", reason: `author=${pr.user.login}` };
  }
  if (!pr.head.repo || pr.head.repo.full_name !== repo) {
    log(`skip: fork PR (head repo ${pr.head.repo && pr.head.repo.full_name})`);
    return { outcome: "skip", reason: "fork-pr" };
  }

  const idemKey = idempotencyKey(pr.base.sha, pr.head.sha);
  const comments = await fetchComments(repo, prNumber);
  if (comments.some((c) => c.body && c.body.includes(idemKey))) {
    log(`skip: idempotency comment already present for ${idemKey}`);
    return { outcome: "skip", reason: "idempotent-already-resolved" };
  }

  // Collect everything the PR changes. The API caps `files` at 300 per
  // page; CMS-managed PRs almost always touch one file. If we ever see
  // a CMS PR with >300 files, abort — that's outside this resolver's
  // remit.
  const files = await gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=300`);
  if (files.length >= 300) {
    const reasons = ["PR has 300+ changed files (this resolver only handles small CMS edits)"];
    log(`abort: ${reasons.join(", ")}`);
    if (!dryRun) {
      await postComment(repo, prNumber, formatAbortComment(idemKey, reasons));
    }
    return { outcome: "abort", reasons };
  }

  const reasons = [];
  for (const f of files) {
    if (!isPathAllowed(f.filename)) {
      reasons.push(`path \`${f.filename}\` not in PATH_ALLOWLIST`);
      continue;
    }
    if (f.status === "removed") {
      reasons.push(`\`${f.filename}\` was removed in this PR — resolver doesn't handle deletes`);
      continue;
    }
    if (f.status === "added") {
      reasons.push(
        `\`${f.filename}\` is a new file in this PR — newline-equivalence with main is not meaningful`,
      );
      continue;
    }
    // Binary detection: GitHub omits `patch` for binaries, and `changes` is
    // populated as line counts only for text. Use both signals defensively.
    if (typeof f.patch !== "string" && f.changes > 0) {
      reasons.push(`\`${f.filename}\` appears to be binary`);
      continue;
    }
  }

  if (reasons.length > 0) {
    log(`abort (path/status checks): ${reasons.length} reason(s)`);
    if (!dryRun) {
      await postComment(repo, prNumber, formatAbortComment(idemKey, reasons));
    }
    return { outcome: "abort", reasons };
  }

  // Per-file equivalence
  const resolvedPaths = [];
  for (const f of files) {
    const baseContent = await fetchFileAtRef(repo, pr.base.ref, f.filename);
    const headContent = await fetchFileAtRef(repo, pr.head.ref, f.filename);
    if (baseContent === null || headContent === null) {
      reasons.push(
        `\`${f.filename}\` missing on one side (base=${baseContent === null ? "null" : "ok"}, head=${headContent === null ? "null" : "ok"})`,
      );
      continue;
    }
    if (hasCodeFence(baseContent) || hasCodeFence(headContent)) {
      reasons.push(
        `\`${f.filename}\` contains a markdown code fence — meaningful blank lines may exist`,
      );
      continue;
    }
    if (canonical(baseContent) !== canonical(headContent)) {
      reasons.push(`\`${f.filename}\` diff is not newline-only (canonical-collapse mismatch)`);
      continue;
    }
    resolvedPaths.push(f.filename);
  }

  if (reasons.length > 0) {
    log(`abort (equivalence checks): ${reasons.length} reason(s)`);
    if (!dryRun) {
      await postComment(repo, prNumber, formatAbortComment(idemKey, reasons));
    }
    return { outcome: "abort", reasons };
  }

  // All files pass: the PR's diff is purely newline-mangling. Main
  // already has the canonical content, so closing the PR loses no
  // intent.
  if (dryRun) {
    log(`dry-run: would close PR #${prNumber} (paths: ${resolvedPaths.join(", ")})`);
    return { outcome: "would-close", paths: resolvedPaths };
  }

  await postComment(repo, prNumber, formatCloseComment(idemKey, resolvedPaths));
  await closePr(repo, prNumber);
  log(`closed PR #${prNumber}`);
  return { outcome: "closed", paths: resolvedPaths };
}

async function main() {
  const repo = process.env.GH_REPO;
  const prNumber = process.env.PR_NUMBER;
  const dryRun = process.env.DRY_RUN === "true";
  if (!repo) throw new Error("GH_REPO env var is required");
  if (!prNumber) throw new Error("PR_NUMBER env var is required");
  if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN env var is required");

  const log = (m) => console.log(`[auto-resolve-newline] ${m}`);
  const result = await run({ repo, prNumber, dryRun, log });
  log(`result: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[auto-resolve-newline] ERROR: ${e.message}`);
    if (e.stack) console.error(e.stack);
    process.exit(1);
  });
}

module.exports = {
  PATH_ALLOWLIST,
  HEAD_REF_ALLOWLIST,
  AUTHOR_ALLOWLIST,
  COMMENT_MARKER,
  canonical,
  isPathAllowed,
  isHeadRefAllowed,
  isAuthorAllowed,
  hasCodeFence,
  idempotencyKey,
  formatAbortComment,
  formatCloseComment,
  run,
};
