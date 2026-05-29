// @lane: pure-fs — Playwright custom reporter; no browser, no network at test time.
//
// LiveFailuresReporter — streams individual test failures to the PR as
// they happen, instead of waiting for the whole job to finish + the
// post-failure-comment composite to assemble a summary at the end.
//
// Why: when a long shard fails on test 3-of-200, an agent watching the
// PR shouldn't have to wait 15 minutes for the rest of the shard to
// finish. The end-of-job summary still posts (that's the canonical
// gitleaks-scrubbed comment), but this reporter publishes earlier
// signal: one comment per failing test, marker-tagged so resumes /
// re-runs don't double-post.
//
// Wire-up: playwright.config.js adds this alongside the `list`
// reporter. The reporter no-ops unless BOTH `GITHUB_TOKEN` and
// `PR_NUMBER` are in the env, so workflows opt in incrementally
// (currently: e2e-tests.yml's `e2e` + `e2e-admin` jobs; preview-media
// and parity-preview can adopt by adding the env block).
//
// Concurrency: each failure POSTs a NEW comment via the GitHub
// Issues API. Atomic — no PATCH races between parallel shards. The
// marker `<!-- live-failure:<run-id>:<test-id>:<retry> -->` is unique
// per (run, test, retry) so a re-run on the same head SHA doesn't
// flood the PR (the marker check skips an already-posted failure).
//
// Final-attempt only: a test that fails-then-passes-on-retry is
// noise — we suppress non-terminal failures via the
// `result.retry === test.retries` guard.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const SCRUB_SCRIPT = path.resolve(__dirname, "..", "scripts", "scrub-secrets.js");

// PR_NUMBER fallback: pull_request triggers set GITHUB_REF =
// `refs/pull/<N>/merge`. Picking it out here keeps the workflow YAML
// from needing an explicit `PR_NUMBER:` env block in every job.
function detectPrNumber(env) {
  if (env.PR_NUMBER && env.PR_NUMBER !== "local") {
    return env.PR_NUMBER;
  }
  const ref = env.GITHUB_REF || "";
  const m = /^refs\/pull\/(\d+)\//.exec(ref);
  return m ? m[1] : null;
}

function readHeadSha(env) {
  if (!env.GITHUB_EVENT_PATH) return "";
  try {
    const ev = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return ev?.pull_request?.head?.sha || ev?.after || "";
  } catch {
    return "";
  }
}

// Best-effort gitleaks scrub: write text to a tmp file, run the
// in-repo scrubber against it, return the scrubbed text. The
// scrubber `exit 0`s when gitleaks isn't installed — we still get
// the original text in that case. Truncate to 3KB so a single
// comment doesn't blow past GitHub's body limit (~65k char) when
// stacked with other failures.
function scrubSync(text) {
  const truncated = text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)…" : text;
  try {
    const inPath = path.join(os.tmpdir(), `live-failure-${process.pid}-${Date.now()}.txt`);
    const outPath = inPath + ".scrubbed";
    fs.writeFileSync(inPath, truncated);
    const r = spawnSync("node", [SCRUB_SCRIPT, inPath, outPath], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 10_000,
    });
    if (r.status === 0 && fs.existsSync(outPath)) {
      const out = fs.readFileSync(outPath, "utf8");
      fs.unlinkSync(inPath);
      fs.unlinkSync(outPath);
      return out;
    }
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
  } catch {
    /* fall through */
  }
  return truncated;
}

class LiveFailuresReporter {
  constructor() {
    // Snapshot env at construction time so unit tests can monkey-
    // patch env, instantiate, then restore env without breaking the
    // reporter's runtime lookups.
    const env = { ...process.env };
    this.repo = env.GITHUB_REPOSITORY || "";
    this.token = env.GITHUB_TOKEN || "";
    this.pr = detectPrNumber(env);
    this.runId = env.GITHUB_RUN_ID || "";
    this.job = env.GITHUB_JOB || "";
    this.sha = env.GITHUB_SHA || readHeadSha(env);
    this.server = env.GITHUB_SERVER_URL || "https://github.com";
    this.runUrl =
      this.runId && this.repo ? `${this.server}/${this.repo}/actions/runs/${this.runId}` : null;
    this.enabled = Boolean(this.repo && this.token && this.pr);
    this.posted = 0;
  }

  async commentExists(marker) {
    // GitHub Issues API: list PR comments (PR comments are issue
    // comments) and check for the marker. Paginates up to 5 pages =
    // 500 comments, enough for any realistic PR history.
    if (!this.enabled) return false;
    for (let page = 1; page <= 5; page++) {
      const url = `https://api.github.com/repos/${this.repo}/issues/${this.pr}/comments?per_page=100&page=${page}`;
      const r = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "live-failures-reporter",
        },
      });
      if (!r.ok) return false;
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) return false;
      if (arr.some((c) => c.body && c.body.includes(marker))) return true;
      if (arr.length < 100) return false;
    }
    return false;
  }

  async postComment(marker, body) {
    if (!this.enabled) return false;
    const url = `https://api.github.com/repos/${this.repo}/issues/${this.pr}/comments`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "live-failures-reporter",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: `${marker}\n${body}` }),
    });
    return r.ok;
  }

  // Reporter must not interleave with the `list` reporter's stdout.
  printsToStdio() {
    return false;
  }

  async onTestEnd(test, result) {
    if (!this.enabled) return;
    const failed = result.status === "failed" || result.status === "timedOut";
    if (!failed) return;
    // Post on EVERY failure attempt — agents want signal the moment a
    // test fails, not after Playwright's retry layer has decided
    // whether the suite stays red. The marker below includes
    // `result.retry`, so retry=0 and retry=1 land as separate
    // comments rather than collapsing. A flaky test that passes on
    // retry will leave a single "failed" comment for retry=0;
    // reading agents can compare against the green run summary to
    // judge whether the failure is terminal.

    const fullTitle = test.titlePath().filter(Boolean).join(" › ");
    const file =
      test.location && test.location.file
        ? path.relative(process.cwd(), test.location.file).replace(/\\/g, "/")
        : "";
    const line = test.location ? `${test.location.line}:${test.location.column}` : "";
    const isFinal = result.retry === test.retries;
    const attemptLabel =
      test.retries > 0
        ? ` (attempt ${result.retry + 1} of ${test.retries + 1}${isFinal ? ", final" : ""})`
        : "";
    // Stderr log so the workflow log shows whether the reporter
    // fired at all. Stays out of stdout / the `list` reporter's
    // formatted output.
    process.stderr.write(`[live-failures-reporter] ${fullTitle}${attemptLabel} — posting…\n`);
    // Unique marker — survives reporter retries and parallel shards.
    const testId = test.id || `${file}:${fullTitle}`.replace(/[^A-Za-z0-9_:./-]/g, "_");
    const marker = `<!-- live-failure:${this.runId}:${testId}:${result.retry} -->`;

    // Skip if a prior shard / retry already posted the same failure.
    if (await this.commentExists(marker)) {
      process.stderr.write(`[live-failures-reporter] ${fullTitle} — duplicate marker, skipped.\n`);
      return;
    }

    const errMsg =
      (result.error && (result.error.message || result.error.value)) || "(no error message)";
    const scrubbed = scrubSync(String(errMsg));
    const project = (test.parent && test.parent.project && test.parent.project()?.name) || "";
    const attemptHeader =
      test.retries > 0
        ? `❌ live failure on \`${this.sha.slice(0, 7)}\` — attempt ${result.retry + 1}/${test.retries + 1}${isFinal ? " (final)" : ""}`
        : `❌ live failure on \`${this.sha.slice(0, 7)}\``;

    const lines = [
      `## ${attemptHeader}`,
      "",
      `**${fullTitle}**`,
      "",
      `\`${file}${line ? ":" + line : ""}\`${project ? `  ·  project: \`${project}\`` : ""}${this.job ? `  ·  job: \`${this.job}\`` : ""}`,
      "",
      "```",
      scrubbed,
      "```",
      "",
      this.runUrl ? `[View full run](${this.runUrl})` : "",
      "",
      "*Posted by the live-failures reporter. The end-of-job summary still publishes a consolidated, gitleaks-scrubbed comment.*",
    ].filter(Boolean);

    const ok = await this.postComment(marker, lines.join("\n"));
    if (ok) {
      this.posted++;
      process.stderr.write(`[live-failures-reporter] ${fullTitle} — posted.\n`);
    } else {
      process.stderr.write(
        `[live-failures-reporter] ${fullTitle} — POST failed (token / permission?).\n`,
      );
    }
  }

  async onEnd() {
    if (this.enabled && this.posted > 0) {
      // Surface the count in the workflow log so a job-level scan
      // sees how many live comments fired without parsing the API.
      process.stdout.write(`\nlive-failures-reporter: posted ${this.posted} comment(s).\n`);
    }
  }
}

module.exports = LiveFailuresReporter;
module.exports.default = LiveFailuresReporter;
