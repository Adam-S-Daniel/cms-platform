#!/usr/bin/env node
"use strict";
// release.yml's one-dispatch mode: after release-candidates.yml has opened both
// consumers' draft PRs, wait until scripts/release-candidate-gate.js passes for
// both, or stop at the first failure. The gate stays the only judge: this only
// decides WHEN to ask it, and whether its refusal can still change.
//
// Each poll reads each draft's head checks (a few calls). The full gate, which
// reads every consumer workflow file twice, runs only once every check on both
// heads has completed or one has failed, and once more at the deadline.
const fs = require("node:fs");
const path = require("node:path");
const { parseYaml } = require("../e2e/workflow-yaml-utils");
const { gate, pages, api, safeError, MISSING, NOT_SUCCEEDED } = require("./release-candidate-gate");

const SHA = /^[0-9a-f]{40}$/;
const PR = /^[1-9][0-9]*$/;
// A result still running is "pending"; a context with no result yet is "missing".
const UNSETTLED = new Set(["pending", "missing"]);
const FAILED = new Set(["failure", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);

// The gate's report → pass, pending (only waiting refusals, nothing terminal)
// or fail. `failing` and `waiting` name each context with its PR and conclusions.
function classify(report) {
  if (report.ok === true) return { state: "pass", failing: [], waiting: [] };
  const failing = [];
  const waiting = [];
  const entries = Array.isArray(report.consumers) ? report.consumers : [];
  let refusedOutright = !entries.some((entry) => entry.error);
  for (const entry of entries) {
    if (!entry.error) continue;
    const rows = Array.isArray(entry.results) ? entry.results : [];
    const terminal = rows.filter((row) => row.conclusions.some((c) => c !== "success" && !UNSETTLED.has(c)));
    const unsettled = rows.filter((row) => row.conclusions.some((c) => UNSETTLED.has(c)));
    const at = { repo: entry.repo, pr: entry.pr };
    failing.push(...terminal.map((row) => ({ ...at, context: row.context, conclusions: row.conclusions, urls: row.urls })));
    if (terminal.length === 0 && [MISSING, NOT_SUCCEEDED].includes(entry.error) && unsettled.length > 0) {
      waiting.push(...unsettled.map((row) => ({ ...at, context: row.context, conclusions: row.conclusions })));
    } else if (terminal.length === 0) {
      failing.push({ ...at, error: entry.error });
    }
  }
  // A refusal no consumer entry explains (bad identity, manifest, or a revision
  // that moved during validation) can never resolve by waiting.
  if (refusedOutright) failing.push({ error: report.error || "Release candidate gate refused" });
  return { state: failing.length ? "fail" : "pending", failing, waiting };
}

// One cheap read of a draft's head: has every check completed, and has any failed?
async function probe(read, repo, pr) {
  if (!PR.test(String(pr || ""))) return { settled: true, failed: false, waiting: [] };
  try {
    const pull = await read(repo, `repos/${repo}/pulls/${pr}`);
    const head = pull?.head?.sha;
    if (!SHA.test(head)) return { settled: false, failed: false, waiting: [] };
    const latest = new Map();
    for (const check of await pages(read, repo, `repos/${repo}/commits/${head}/check-runs?filter=all`, "check_runs")) {
      const key = `${check.name}:${check.app?.id}`;
      if (!latest.has(key) || latest.get(key).id < check.id) latest.set(key, check);
    }
    const statuses = new Map();
    for (const status of await pages(read, repo, `repos/${repo}/commits/${head}/statuses`, null)) {
      if (!statuses.has(status.context) || statuses.get(status.context).id < status.id) statuses.set(status.context, status);
    }
    const checks = [...latest.values()];
    const waiting = [
      ...checks.filter((c) => c.status !== "completed").map((c) => ({ repo, pr: Number(pr), context: c.name, conclusions: [c.status] })),
      ...[...statuses.values()].filter((s) => s.state === "pending").map((s) => ({ repo, pr: Number(pr), context: s.context, conclusions: ["pending"] })),
    ];
    const failed = checks.some((c) => c.status === "completed" && FAILED.has(c.conclusion)) ||
      [...statuses.values()].some((s) => s.state === "failure" || s.state === "error");
    return { settled: checks.length > 0 && waiting.length === 0, failed, waiting };
  } catch {
    // A read that fails mid-wait is retried on the next poll; the gate itself
    // still fails closed on unreadable data when it runs.
    return { settled: false, failed: false, waiting: [] };
  }
}

async function runGate(args) {
  const report = { ok: false };
  try { await gate({ ...args, report }); } catch (error) { report.error = safeError(error); }
  return report;
}

// Poll until the gate passes or refuses for good, or the deadline passes. At the
// deadline the gate runs once more, so the final verdict is always its own.
async function wait({ args, sleep, now, timeoutMs, intervalMs, log = () => {} }) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const probes = [];
    for (const [repo, pr] of Object.entries(args.prs)) probes.push(await probe(args.read, repo, pr));
    const expired = now() >= deadline;
    let verdict = { state: "pending", failing: [], waiting: probes.flatMap((p) => p.waiting) };
    let report = null;
    if (expired || probes.every((p) => p.settled) || probes.some((p) => p.failed)) {
      report = await runGate(args);
      verdict = classify(report);
      if (verdict.state !== "pending") return { report, verdict };
    }
    if (expired) return { report, verdict: { ...verdict, state: "timeout" } };
    log(`waiting on ${verdict.waiting.length || "unreported"} result(s): ${verdict.waiting.slice(0, 5).map(describe).join("; ")}`);
    await sleep(intervalMs);
  }
}

// Workflow-command escaping (`%`, CR, LF), so a context name cannot end the
// annotation and start another command.
function escape(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function describe(item) {
  const where = item.repo ? `${item.repo}#${item.pr ?? "?"}` : "release gate";
  if (item.error) return escape(`${where}: ${item.error}`);
  const urls = (item.urls || []).length ? ` ${item.urls.join(" ")}` : "";
  return escape(`${where}: "${item.context}" is ${item.conclusions.join(", ")}${urls}`);
}

// Same rule as the gate: only messages written here reach the log.
function refusal(message) { const error = new Error(message); error.safe = true; return error; }

async function main() {
  const destination = process.env.CANDIDATE_REPORT;
  let report = { ok: false };
  try {
    if (typeof destination !== "string" || !path.isAbsolute(destination)) throw refusal("Absolute candidate report path required");
    const timeoutMs = Number(process.env.POLL_SECONDS) * 1000;
    const intervalMs = Number(process.env.POLL_INTERVAL) * 1000;
    if (!(timeoutMs >= 0) || !(intervalMs > 0)) throw refusal("POLL_SECONDS and POLL_INTERVAL must be numbers");
    const args = {
      candidate: process.env.CANDIDATE_SHA, platform: process.env.GH_REPO, version: process.env.VERSION,
      manifest: parseYaml(fs.readFileSync("repo-settings.yml", "utf8")), read: api,
      prs: { "Adam-S-Daniel/adamdaniel.ai": process.env.CANDIDATE_ADAMDANIEL_AI_PR, "jodidaniel/jodidaniel.com": process.env.CANDIDATE_JODIDANIEL_COM_PR },
    };
    const result = await wait({
      args, timeoutMs, intervalMs, now: () => Date.now(), sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
      log: (line) => console.log(line),
    });
    report = result.report;
    const { verdict } = result;
    if (verdict.state === "pass") {
      console.log("Both consumer candidates pass the release gate.");
    } else if (verdict.state === "timeout") {
      console.error(`::error::Candidates did not finish within ${process.env.POLL_SECONDS}s; not releasing.`);
      for (const item of verdict.waiting) console.error(`::error::still waiting: ${describe(item)}`);
      process.exitCode = 1;
    } else {
      for (const item of verdict.failing) console.error(`::error::${describe(item)}`);
      process.exitCode = 1;
    }
  } catch (error) {
    report = { ok: false, error: safeError(error) };
    console.error(`::error::${report.error}`);
    process.exitCode = 1;
  } finally {
    try { fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n"); }
    catch { console.error("::error::Could not write candidate wait report"); process.exitCode = 1; }
  }
}

module.exports = { classify, probe, wait, describe };
if (require.main === module) main();
