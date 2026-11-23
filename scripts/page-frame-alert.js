#!/usr/bin/env node
// Turn a page-frame check run against production into alerts (cms-platform#1070).
//
//   node scripts/page-frame-alert.js --report <playwright.json> --repo <owner/name>
//     --sha <commit> [--run-url <url>] [--assignees a,b] [--label page-broken]
//     [--base main] [--dry-run]
//
// For every page that failed e2e/page-frame.spec.js:
//   - one open issue per page (the publish watchdog's shape), assigned so the
//     owner gets an email. A page that already has an open issue gets nothing new;
//   - for a post, a prepared pull request that sets `published: false`, so
//     retracting it is one merge. Opened with the CMS automation App's token
//     (PAGE_FRAME_APP_TOKEN), because a pull request opened with GITHUB_TOKEN
//     starts no checks and so could never merge. Without the App the issue says
//     how to unpublish in /admin instead.
// For every page that passed and still has an open issue: close the issue and
// its unpublish pull request, saying which commit fixed it.
//
// Nothing is retracted automatically. When the preview check passed minutes
// earlier, a live failure is more likely a deploy or cache fault than the post,
// and an automatic unpublish would turn that into a dead link behind a
// cross-post already sent (issue 1070, "Automatic retract").
//
// Logs carry statuses and page paths only, never an API response body.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const MARKER = "page-frame";
const GH_TIMEOUT_MS = 60_000;

// ── Pure parts (unit-tested in e2e/page-frame-alert.test.js) ─────────────────

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || "").replace(/\u001b\[[0-9;]*m/g, "");
}

// Every page-frame test in a Playwright JSON report, as
// { page, source, outcome: "failed" | "passed" | "skipped", message }.
function parseReport(report) {
  const out = [];
  const walk = (suite) => {
    for (const s of suite.suites || []) walk(s);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const ann = t.annotations || [];
        const page = (ann.find((a) => a.type === "page") || {}).description;
        if (!page) continue;
        const source = (ann.find((a) => a.type === "source") || {}).description || null;
        const results = t.results || [];
        const last = results[results.length - 1] || {};
        const outcome =
          t.status === "unexpected" ? "failed" : t.status === "skipped" ? "skipped" : "passed";
        const message = stripAnsi((last.error && last.error.message) || "");
        out.push({ page, source, outcome, message });
      }
    }
  };
  for (const s of report.suites || []) walk(s);
  return out;
}

// Set `published: false` in a post's front matter, leaving every other byte
// alone. null when the file has no front matter or is already unpublished.
function unpublishFrontMatter(text) {
  const m = /^---(\r?\n)([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const nl = m[1];
  const lines = m[2].split(/\r?\n/);
  const i = lines.findIndex((l) => /^published\s*:/.test(l));
  if (i >= 0) {
    if (/^published\s*:\s*["']?false["']?\s*(#.*)?$/i.test(lines[i])) return null;
    lines[i] = "published: false";
  } else {
    lines.push("published: false");
  }
  const head = `---${nl}${lines.join(nl)}${nl}---`;
  return head + text.slice(m[0].length);
}

const markerFor = (page) => `<!-- ${MARKER}: ${page} -->`;
const prMarkerRe = /<!-- page-frame-unpublish-pr: (\d+) -->/;

function pageFromIssue(issue) {
  const m = /<!-- page-frame: (\S+) -->/.exec(issue.body || "");
  return m ? m[1] : null;
}

// What to do, given the parsed results and the open alert issues. With
// `all` (the daily sweep checked every published post), an open issue for a
// page the run did not check is closed too: its post was unpublished (often by
// merging the prepared pull request) or removed, so nothing will check it again.
function plan(results, openIssues, { all = false } = {}) {
  const byPage = new Map();
  for (const issue of openIssues) {
    const page = pageFromIssue(issue);
    if (page) byPage.set(page, issue);
  }
  const open = [];
  const close = [];
  const still = [];
  for (const r of results) {
    const issue = byPage.get(r.page);
    if (r.outcome === "failed") (issue ? still : open).push(issue ? { ...r, issue } : r);
    else if (r.outcome === "passed" && issue) close.push({ ...r, issue });
  }
  const checked = new Set(results.map((r) => r.page));
  // A sweep that checked no page at all (the run crashed before any page test)
  // says nothing about which posts are published: close nothing as gone.
  const gone = all && results.length > 0 ? [...byPage].filter(([page]) => !checked.has(page)).map(([page, issue]) => ({ page, issue })) : [];
  return { open, close, still, gone };
}

function issueBody({ result, sha, runUrl, prodUrl, pr, prError }) {
  const live = prodUrl ? `${prodUrl.replace(/\/+$/, "")}${result.page}` : result.page;
  const lines = [
    markerFor(result.page),
    pr ? `<!-- page-frame-unpublish-pr: ${pr.number} -->` : "",
    "",
    `The page frame around ${live} is broken on the live site, checked after commit ${sha}.`,
    "Readers may be missing the menu or footer, unable to click them, or scrolling sideways.",
    "",
    "What the check found:",
    "",
    "```",
    result.message.trim() || "(no message)",
    "```",
    "",
  ];
  if (pr) {
    lines.push(`To take the post down now, merge ${pr.html_url}. It sets the post to unpublished and changes nothing else.`);
  } else if (result.source) {
    lines.push(
      `To take the post down now, open it in /admin and turn off Published, or set \`published: false\` in \`${result.source}\`.`,
    );
    if (prError) lines.push(`(No unpublish pull request was prepared: ${prError}.)`);
  }
  lines.push(
    "",
    "Nothing has been retracted automatically. If the page looks fine to you, the cause may be a deploy or cache fault; the next check closes this issue when the page passes.",
  );
  if (runUrl) lines.push("", `Check run: ${runUrl}`);
  return lines.filter((l, i) => !(l === "" && i === 1)).join("\n");
}

// ── GitHub calls ─────────────────────────────────────────────────────────────

function ghError(what, err) {
  const stderr = err && err.stderr ? String(err.stderr) : "";
  const m = /HTTP (\d{3})/.exec(stderr);
  const e = new Error(`${what} failed (status ${m ? m[1] : "unknown"})`);
  e.status = m ? m[1] : null;
  return e;
}

function ghApi(what, endpoint, { method, body, token } = {}) {
  const args = ["api", endpoint];
  if (method) args.push("-X", method);
  if (body !== undefined) args.push("--input", "-");
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      timeout: GH_TIMEOUT_MS,
      env,
      input: body !== undefined ? JSON.stringify(body) : undefined,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (err) {
    throw ghError(what, err);
  }
}

function slugOf(page) {
  return page.replace(/^\/+|\/+$/g, "").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "home";
}

function prepareUnpublishPr({ repo, base, result, token }) {
  const enc = encodeURIComponent;
  const filePath = result.source.split("/").map(enc).join("/");
  const file = ghApi("reading the post", `repos/${repo}/contents/${filePath}?ref=${enc(base)}`, { token });
  const text = Buffer.from(file.content, "base64").toString("utf8");
  const edited = unpublishFrontMatter(text);
  if (edited === null) throw new Error("the post is already unpublished on the base branch");
  const branch = `page-frame/unpublish-${slugOf(result.page)}`;
  const baseRef = ghApi("reading the base branch", `repos/${repo}/git/ref/heads/${enc(base)}`, { token });
  try {
    ghApi("creating the branch", `repos/${repo}/git/refs`, {
      method: "POST",
      token,
      body: { ref: `refs/heads/${branch}`, sha: baseRef.object.sha },
    });
  } catch (err) {
    if (err.status !== "422") throw err;
    // A branch from an earlier alert for the same page: start it again from base.
    ghApi("resetting the branch", `repos/${repo}/git/refs/heads/${branch}`, {
      method: "PATCH",
      token,
      body: { sha: baseRef.object.sha, force: true },
    });
  }
  ghApi("committing the change", `repos/${repo}/contents/${filePath}`, {
    method: "PUT",
    token,
    body: {
      message: `Unpublish ${result.page}: its page frame is broken on the live site`,
      content: Buffer.from(edited, "utf8").toString("base64"),
      sha: file.sha,
      branch,
    },
  });
  const existing = ghApi("listing pull requests", `repos/${repo}/pulls?state=open&head=${enc(`${repo.split("/")[0]}:${branch}`)}`, { token });
  if (existing && existing.length) return existing[0];
  return ghApi("opening the pull request", `repos/${repo}/pulls`, {
    method: "POST",
    token,
    body: {
      title: `Unpublish ${result.page} (its page is broken on the live site)`,
      head: branch,
      base,
      body: `Sets \`published: false\` in \`${result.source}\` and changes nothing else. Prepared by the page-frame check; merge it to take the post down. See the linked alert issue for what broke.`,
    },
  });
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const reportPath = flag(argv, "--report");
  const repo = flag(argv, "--repo");
  const sha = flag(argv, "--sha") || "";
  const runUrl = flag(argv, "--run-url") || "";
  const prodUrl = flag(argv, "--prod-url") || "";
  const base = flag(argv, "--base") || "main";
  const label = flag(argv, "--label") || "page-broken";
  const assignees = (flag(argv, "--assignees") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const dryRun = argv.includes("--dry-run");
  const all = argv.includes("--all");
  if (!reportPath || !repo) {
    console.error("usage: page-frame-alert.js --report <json> --repo <owner/name> --sha <commit>");
    return 2;
  }
  if (!fs.existsSync(reportPath)) {
    console.error(`::error::No Playwright report at ${reportPath}; the check did not run, so nothing can be reported.`);
    return 1;
  }
  const results = parseReport(JSON.parse(fs.readFileSync(reportPath, "utf8")));
  const openIssues = dryRun
    ? []
    : ghApi("listing open alert issues", `repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`) || [];
  const p = plan(results, openIssues.filter((i) => !i.pull_request), { all });
  console.log(`Checked ${results.length} page(s): ${p.open.length} newly broken, ${p.still.length} still broken, ${p.close.length} fixed, ${p.gone.length} no longer published.`);
  if (dryRun) {
    for (const r of p.open) console.log(`  would open an issue for ${r.page}`);
    return p.open.length + p.still.length ? 1 : 0;
  }
  const appToken = process.env.PAGE_FRAME_APP_TOKEN || "";
  let failures = 0;
  for (const result of p.open) {
    let pr = null;
    let prError = "";
    if (result.source) {
      if (!appToken) {
        prError = process.env.PAGE_FRAME_APP_MINT === "failure"
          ? "the CMS automation App's token could not be minted (read the run log)"
          : "the CMS automation App is not set up on this repository";
      } else {
        try {
          pr = prepareUnpublishPr({ repo, base, result, token: appToken });
        } catch (err) {
          prError = err.message;
          console.log(`::warning::${result.page}: ${err.message}`);
        }
      }
    }
    const body = issueBody({ result, sha, runUrl, prodUrl, pr, prError });
    const issue = { title: `Broken page on the live site: ${result.page}`, body, labels: [label] };
    if (assignees.length) issue.assignees = assignees;
    try {
      const made = ghApi("opening the alert issue", `repos/${repo}/issues`, { method: "POST", body: issue });
      console.log(`Opened issue #${made.number} for ${result.page}${pr ? ` with unpublish PR #${pr.number}` : ""}.`);
    } catch (err) {
      failures += 1;
      console.log(`::error::${result.page}: ${err.message}`);
    }
  }
  for (const { page, issue } of p.still) console.log(`Issue #${issue.number} already tracks ${page}.`);
  const closing = [
    ...p.close.map((c) => ({ ...c, why: "passed" })),
    ...p.gone.map((c) => ({ ...c, why: "gone" })),
  ];
  for (const { page, issue, why } of closing) {
    const note = why === "passed"
      ? `The page frame check passed on ${page} after commit ${sha}${runUrl ? ` (${runUrl})` : ""}, so this is resolved.`
      : `${page} is no longer a published post as of commit ${sha}, so the page frame check no longer opens it. Closing.`;
    try {
      const prNum = (prMarkerRe.exec(issue.body || "") || [])[1];
      if (prNum) {
        ghApi("commenting on the unpublish PR", `repos/${repo}/issues/${prNum}/comments`, { method: "POST", body: { body: `${note} Closing this unpublish pull request.` } });
        ghApi("closing the unpublish PR", `repos/${repo}/pulls/${prNum}`, { method: "PATCH", body: { state: "closed" } });
      }
      ghApi("commenting on the issue", `repos/${repo}/issues/${issue.number}/comments`, { method: "POST", body: { body: note } });
      ghApi("closing the issue", `repos/${repo}/issues/${issue.number}`, { method: "PATCH", body: { state: "closed", state_reason: "completed" } });
      console.log(`Closed issue #${issue.number}: ${page} ${why === "passed" ? "passes now" : "is no longer published"}.`);
    } catch (err) {
      failures += 1;
      console.log(`::error::${page}: ${err.message}`);
    }
  }
  return failures ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { parseReport, unpublishFrontMatter, plan, issueBody, pageFromIssue, slugOf };
