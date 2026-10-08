#!/usr/bin/env node
"use strict";
// Stable tags are promotion: both consumers must have tested this exact platform
// commit on draft branches while their production branches retain the old pins.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { parseYaml } = require("../e2e/workflow-yaml-utils");
const { parseCandidateGemfile } = require("./check-platform-pin-consistency");
const ACTIONS_APP = 15368;
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
function demand(ok, message) { if (!ok) { const error = new Error(message); error.safe = true; throw error; } }
function safeError(error) { return error?.safe === true ? error.message : "Required data unavailable or invalid"; }
function yaml(text) {
  try { const value = parseYaml(text); demand(value && typeof value === "object", "Invalid YAML data"); return value; }
  catch { demand(false, "Invalid YAML data"); }
}
function contexts(rules) {
  demand(Array.isArray(rules), "Required rules unavailable");
  const out = [];
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") continue;
    const checks = rule.parameters?.required_status_checks;
    demand(Array.isArray(checks) && checks.length > 0, "Required contexts unavailable");
    for (const item of checks) {
      demand(item && typeof item.context === "string" && item.context.trim() &&
        (item.integration_id == null || Number.isInteger(item.integration_id) && item.integration_id > 0), "Invalid required context");
      out.push({ context: item.context, integration_id: item.integration_id ?? null });
    }
  }
  demand(out.length > 0, "Required contexts unavailable");
  return out;
}
function consumers(manifest) {
  const repos = Object.entries(manifest.repos || {}).filter(([, value]) => value.rulesets?.main === "consumer-main").map(([repo]) => repo);
  demand(repos.length === 2 && repos.every((repo) => REPO.test(repo)), "Exactly two consumer-main repositories required");
  return repos;
}
function lock(text, platform) {
  const value = yaml(text);
  demand(value.platform_repo === platform && typeof value.platform_ref === "string" && value.platform_ref.trim(), "Invalid platform lock");
  return value.platform_ref;
}
// Gemfile.lock is a data format, not Ruby code. Read each GIT source's fields;
// the gem's own source must carry both the immutable revision and ref.
function gemPin(text, platform, candidate, ref = candidate) {
  const sources = text.split(/\r?\n(?=GIT\r?\n)/).filter((s) => s.startsWith("GIT\n") || s.startsWith("GIT\r\n"));
  const matching = sources.map((source) => {
    const data = {};
    for (const line of source.split(/\r?\n/).slice(1)) {
      if (/^[A-Z]/.test(line)) break;
      const field = /^  (remote|revision|ref|tag|branch): (.+)$/.exec(line);
      if (field) {
        demand(!(field[1] in data), "Duplicate theme source field");
        data[field[1]] = field[2];
      }
      if (/^    cms-platform-theme \(/.test(line)) data.theme = true;
    }
    return data;
  }).filter((source) => source.theme);
  demand(matching.length === 1, "Theme GIT source missing or ambiguous");
  const source = matching[0];
  demand(source.remote === `https://github.com/${platform}.git` || source.remote === `https://github.com/${platform}`, "Theme source is not the platform repository");
  demand(source.revision === candidate && !source.branch &&
    (SHA.test(ref) ? source.ref === ref && !source.tag : source.tag === ref && !source.ref), "Theme does not pin the exact candidate");
}
function workflowPins(workflow, platform, candidate) {
  let count = 0;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "uses" && typeof item === "string" && item.startsWith(`${platform}/`)) {
        demand(item.slice(item.lastIndexOf("@") + 1) === candidate, "Workflow does not pin the exact candidate"); count++;
      }
      if (key === "platform_ref") demand(item === candidate, "Workflow input does not pin the exact candidate");
      visit(item);
    }
  }
  visit(workflow);
  return count;
}
function workContexts(workflows, platform, candidate, matrix) {
  const slots = matrix.jobs?.project?.strategy?.matrix?.include;
  demand(Array.isArray(slots) && slots.length > 0 && slots.every((s) => typeof s.slot === "string" && s.slot), "Candidate e2e matrix unavailable");
  const result = [];
  let e2e = 0, verify = 0;
  for (const workflow of workflows) {
    for (const [job, data] of Object.entries(workflow.jobs || {})) {
      if (data.uses === `${platform}/.github/workflows/e2e-tests.yml@${candidate}`) {
        demand(data.with?.target === "local" && data.with?.browser === "all" &&
          data.with?.platform_ref === candidate && (data.with?.platform_repo == null || data.with.platform_repo === platform),
          "Consumer e2e must test its local site with all browsers and the exact candidate harness");
        e2e++;
        result.push(...slots.map((s) => ({ context: `${callerName(job, data)} / project (${s.slot})`,
          integration_id: ACTIONS_APP, steps: ["Run Playwright suite"] })));
      }
      if (data.uses === `${platform}/.github/workflows/site-verify.yml@${candidate}`) {
        verify++; result.push({ context: `${callerName(job, data)} / verify`, integration_id: ACTIONS_APP,
          steps: ["Detect the site's verifier and self-tests", "Run the site's verifier self-tests"], siteVerifier: true });
      }
    }
  }
  demand(e2e === 1 && verify === 1, "Consumer validation callers missing or ambiguous");
  return result;
}
function callerName(job, data) {
  const name = data.name ?? job;
  demand(typeof name === "string" && name.trim() && !name.includes("${{"), "Consumer validation caller name is invalid");
  return name;
}
async function verifyWork(read, repo, checks, work, head) {
  const scripts = await read(repo, `repos/${repo}/contents/scripts?ref=${head}`);
  demand(Array.isArray(scripts) && scripts.every((item) => item && typeof item.path === "string"), "Consumer verifier listing unavailable");
  const hasVerifier = scripts.some((item) => item.path === "scripts/verify-build-artifacts.rb" && item.type === "file");
  for (const item of work) {
    const check = checks.filter((c) => c.name === item.context && c.app.id === ACTIONS_APP)
      .sort((a, b) => b.id - a.id)[0];
    const prefix = `https://github.com/${repo}/actions/runs/`;
    demand(check && typeof check.details_url === "string" && check.details_url.startsWith(prefix), "Validation job URL unavailable");
    const match = /^([1-9][0-9]*)\/job\/([1-9][0-9]*)$/.exec(check.details_url.slice(prefix.length));
    demand(match, "Invalid validation job URL");
    const job = await read(repo, `repos/${repo}/actions/jobs/${match[2]}`);
    demand(job.id === Number(match[2]) && job.run_id === Number(match[1]) && job.head_sha === head &&
      job.name === item.context && job.status === "completed" && job.conclusion === "success" &&
      Array.isArray(job.steps), "Validation work job is incomplete or invalid");
    for (const name of [...item.steps, ...(item.siteVerifier && hasVerifier ? ["Build the site", "Run the site's verifier"] : [])]) {
      const steps = job.steps.filter((step) => step.name === name);
      demand(steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "success",
        "A required validation step is missing or did not succeed");
    }
  }
}
function evaluate(checks, statuses, required, head, rows = []) {
  demand(Array.isArray(checks) && Array.isArray(statuses), "Result data unavailable");
  const latest = new Map();
  for (const check of checks) {
    demand(Number.isInteger(check.id) && typeof check.name === "string" && SHA.test(check.head_sha) &&
      ["queued", "in_progress", "completed", "waiting", "requested", "pending"].includes(check.status) &&
      (check.conclusion == null || ["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "startup_failure", "stale"].includes(check.conclusion)) &&
      Number.isInteger(check.app?.id), "Invalid check result");
    const key = `check:${check.name}:${check.app.id}`;
    if (!latest.has(key) || latest.get(key).id < check.id) latest.set(key, {
      id: check.id, context: check.name, app: check.app.id,
      conclusion: check.head_sha !== head ? "wrong_head" : check.status === "completed" ? check.conclusion : "pending", url: check.details_url,
    });
  }
  for (const status of statuses) {
    demand(Number.isInteger(status.id) && typeof status.context === "string" && ["success", "failure", "error", "pending"].includes(status.state), "Invalid legacy status");
    const key = `status:${status.context}`;
    if (!latest.has(key) || latest.get(key).id < status.id) latest.set(key, {
      id: status.id, context: status.context, app: null, conclusion: status.state, url: status.target_url,
    });
  }
  const results = [...latest.values()];
  for (const rule of required) {
    const matches = results.filter((r) => r.context === rule.context && (rule.integration_id == null || rule.integration_id === r.app));
    rows.push({ context: rule.context, conclusions: matches.length ? matches.map((r) => r.conclusion) : ["missing"], urls: matches.map((r) =>
      typeof r.url === "string" && /^https:\/\/github\.com\//.test(r.url) ? r.url : null).filter(Boolean) });
  }
  demand(!results.some((r) => ["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale", "wrong_head"].includes(r.conclusion)), "A consumer result failed or was cancelled or names a different head");
  demand(rows.every((r) => !r.conclusions.includes("missing")), "A required validation result is missing");
  demand(rows.every((r) => r.conclusions.every((value) => value === "success")), "A required validation result did not succeed");
  return rows;
}
async function gate({ candidate, platform, version, manifest, prs, read, report = {} }) {
  demand(SHA.test(candidate) && REPO.test(platform) && /^v\d+\.\d+\.\d+$/.test(version), "Invalid candidate identity");
  const repos = consumers(manifest);
  const declared = contexts(manifest.ruleset_library?.["consumer-main"]?.rules);
  const candidateMatrix = yaml(await file(read, platform, ".github/workflows/e2e-tests.yml", candidate));
  Object.assign(report, { candidate, version, consumers: [] });
  for (const repo of repos) {
    const number = prs[repo];
    const entry = { repo, results: [] };
    report.consumers.push(entry);
    try {
      demand(/^[1-9][0-9]*$/.test(String(number || "")), "Both consumer candidate PR numbers required");
      entry.pr = Number(number);
      const pull = await read(repo, `repos/${repo}/pulls/${number}`);
      demand(pull.state === "open" && pull.draft === true && pull.base?.ref === "main" &&
        pull.base.repo?.full_name === repo && pull.head?.repo?.full_name === repo && SHA.test(pull.head.sha), "Candidate must be an open same-repository draft PR into main");
      const head = pull.head.sha;
      entry.head = head;
      const main = await read(repo, `repos/${repo}/commits/main`);
      demand(SHA.test(main.sha), "Consumer main revision unavailable");
      entry.main = main.sha;
      const productionRef = lock(await file(read, repo, "platform.lock", main.sha), platform);
      const production = await read(platform, `repos/${platform}/commits/${encodeURIComponent(productionRef)}`);
      demand(SHA.test(production.sha) && production.sha !== candidate, "Candidate already reaches production pins");
      parseCandidateGemfile(await file(read, repo, "Gemfile", main.sha), platform, productionRef);
      gemPin(await file(read, repo, "Gemfile.lock", main.sha), platform, production.sha, productionRef);
      const productionWorkflows = await workflowsAt(read, repo, main.sha);
      demand(productionWorkflows.reduce((n, wf) => n + workflowPins(wf, platform, productionRef), 0) > 0, "Production platform callers unavailable");
      demand(lock(await file(read, repo, "platform.lock", head), platform) === candidate, "Consumer lock does not pin the exact candidate");
      const gemfile = parseCandidateGemfile(await file(read, repo, "Gemfile", head), platform);
      demand(gemfile.ref === candidate, "Gemfile does not pin the exact candidate");
      gemPin(await file(read, repo, "Gemfile.lock", head), platform, candidate);
      const workflows = await workflowsAt(read, repo, head);
      demand(workflows.reduce((n, wf) => n + workflowPins(wf, platform, candidate), 0) > 0, "Platform callers unavailable");
      const work = workContexts(workflows, platform, candidate, candidateMatrix);
      const live = contexts(await read(repo, `repos/${repo}/rules/branches/main`));
      const required = [...declared, ...live, ...work];
      const checks = await pages(read, repo, `repos/${repo}/commits/${head}/check-runs?filter=all`, "check_runs");
      const statuses = await pages(read, repo, `repos/${repo}/commits/${head}/statuses`, null);
      evaluate(checks, statuses, required, head, entry.results);
      await verifyWork(read, repo, checks, work, head);
      const currentPull = await read(repo, `repos/${repo}/pulls/${number}`);
      const currentMain = await read(repo, `repos/${repo}/commits/main`);
      demand(currentPull.head?.sha === head && currentPull.draft === true && currentPull.state === "open" &&
        currentMain.sha === main.sha, "Consumer revisions changed during validation");
    } catch (error) { entry.error = safeError(error); }
  }
  demand(report.consumers.every((entry) => !entry.error), report.consumers.filter((entry) => entry.error).map((entry) => entry.error).join("; "));
  // Re-read both after collecting both matrices: consumer 1 must still be the
  // revision validated before consumer 2's API reads began.
  for (const item of report.consumers) {
    const pull = await read(item.repo, `repos/${item.repo}/pulls/${item.pr}`);
    const main = await read(item.repo, `repos/${item.repo}/commits/main`);
    demand(pull.head?.sha === item.head && pull.draft === true && pull.state === "open" && main.sha === item.main, "Candidate or production changed during validation");
  }
  report.ok = true;
  return report;
}
async function workflowsAt(read, repo, ref) {
  const listing = await read(repo, `repos/${repo}/contents/.github/workflows?ref=${ref}`);
  demand(Array.isArray(listing) && listing.length > 0, "Consumer workflows unavailable");
  const workflows = [];
  for (const item of listing) {
    demand(item && typeof item.path === "string" && /^\.github\/workflows\/[A-Za-z0-9_.-]+$/.test(item.path), "Invalid workflow path");
    if (/\.ya?ml$/.test(item.path)) workflows.push(yaml(await file(read, repo, item.path, ref)));
  }
  return workflows;
}
async function file(read, repo, rel, ref) {
  const value = await read(repo, `repos/${repo}/contents/${rel}?ref=${encodeURIComponent(ref)}`);
  demand(value.encoding === "base64" && typeof value.content === "string" && /^[A-Za-z0-9+/=\r\n]*$/.test(value.content), "File content unavailable");
  return Buffer.from(value.content, "base64").toString("utf8");
}
async function pages(read, repo, endpoint, key) {
  const values = [];
  for (let page = 1; page <= 1000; page++) {
    const response = await read(repo, `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const batch = key ? response[key] : response;
    demand(Array.isArray(batch), "Invalid paginated results");
    values.push(...batch);
    if (batch.length < 100) return values;
  }
  demand(false, "Result pagination limit exceeded");
}
function api(repo, endpoint) {
  const token = repo === "Adam-S-Daniel/adamdaniel.ai" ? process.env.TOKEN_ADAMDANIEL_AI :
    repo === "jodidaniel/jodidaniel.com" ? process.env.TOKEN_JODIDANIEL_COM : process.env.GH_TOKEN;
  try {
    return JSON.parse(execFileSync("gh", ["api", "--method", "GET", endpoint], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GH_TOKEN: token || process.env.GH_TOKEN },
    }));
  } catch { demand(false, "GitHub read failed or returned invalid data"); }
}
async function main() {
  const report = { ok: false };
  const destination = process.env.CANDIDATE_REPORT;
  try {
    demand(typeof destination === "string" && path.isAbsolute(destination), "Absolute candidate report path required");
    await gate({ candidate: process.env.CANDIDATE_SHA, platform: process.env.GH_REPO, version: process.env.VERSION,
      manifest: yaml(fs.readFileSync("repo-settings.yml", "utf8")), read: api, report,
      prs: { "Adam-S-Daniel/adamdaniel.ai": process.env.CANDIDATE_ADAMDANIEL_AI_PR, "jodidaniel/jodidaniel.com": process.env.CANDIDATE_JODIDANIEL_COM_PR } });
    console.log("Both consumer candidate validation matrices succeeded.");
  } catch (error) {
    // Messages originate here, never from API bodies, credentials or exceptions
    // thrown by a parser/file read. The report contains only selected metadata.
    report.error = safeError(error);
    console.error(`::error::${report.error}`);
    process.exitCode = 1;
  } finally {
    try { demand(typeof destination === "string" && path.isAbsolute(destination), "Report path unavailable"); fs.writeFileSync(destination, JSON.stringify(report, null, 2) + "\n"); }
    catch { console.error("::error::Could not write candidate validation report"); process.exitCode = 1; }
  }
}
module.exports = { gate, contexts, consumers, gemPin, workflowPins, workContexts, evaluate, pages };
if (require.main === module) main();
