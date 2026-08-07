// @lane: local — pure-fs workflow lint; no browser, no build, no network.
//
// Lint: no workflow may install Playwright browsers with a raw, UNBOUNDED
// `npx playwright install` — every lane goes through the
// install-playwright-browsers composite, which bounds each attempt and retries.
//
// WHY THIS EXISTS (measured, adamdaniel.ai run 31177527405, job 92862768030)
// `--with-deps` apt-installs ~90 system packages before downloading the
// browser. On 2026-08-07 the Ubuntu mirror served that job at ~35 KB/s for its
// whole run — each package fetch stalling 86-391 s — so
// `install --with-deps webkit` took 39 MINUTES. Its tests then ran in 41.6 s.
//
// What that cost: the e2e matrix's aggregating `e2e` gate waits for EVERY
// project job, so one stalled lane sets the PR's critical path — and a `cms/*`
// canary PR cannot merge until `e2e / e2e` reports. That lane held
// delete-recovery PR #2953 open for 40 minutes and blew the media-roundtrip
// loop's 30-minute delete-leg budget, failing the loop. Fanning the suite out
// to ten lanes multiplies the exposure: ten independent apt fetches per run.
//
// A bare `timeout-minutes:` is NOT the fix — it converts "slow mirror" into a
// RED required check, which blocks the canary PR permanently instead of merging
// it late. Neither is a UNIFORM retry bound: when the mirror is slow for the
// whole run (the measured case), every attempt hits the same bound and the step
// still exits 1. What works is an ESCALATING budget — short early attempts to
// abandon a stalled connection, then one generous final attempt that can actually
// finish — kept under each caller's own job timeout so the diagnostic survives.
// Hence: one composite, every lane, all three properties asserted here.
//
// Platform-internal: reads the platform's own workflow definitions.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");
const { parseYaml, listWorkflows } = require("./workflow-yaml-utils");

const COMPOSITE_REF = "install-playwright-browsers";
const COMPOSITE_ACTION = path.join(
  __dirname,
  "..",
  ".github",
  "actions",
  COMPOSITE_REF,
  "action.yml",
);

// `playwright install`, `playwright install-deps`, `playwright install chromium
// --with-deps` — any shape that shells out to the installer.
const RAW_INSTALL = /playwright\s+install(-deps)?\b/;

function installSteps() {
  const raw = [];
  const viaComposite = [];
  for (const file of listWorkflows()) {
    const wf = parseYaml(fs.readFileSync(file, "utf8"));
    for (const [jobName, job] of Object.entries(wf.jobs || {})) {
      for (const step of job.steps || []) {
        const where = `${path.basename(file)} :: ${jobName} :: ${step.name || "(unnamed)"}`;
        if (typeof step.run === "string" && RAW_INSTALL.test(step.run)) raw.push(where);
        if (typeof step.uses === "string" && step.uses.endsWith(`/${COMPOSITE_REF}`)) {
          viaComposite.push({ where, with: step.with || {}, jobTimeoutMin: job["timeout-minutes"] });
        }
      }
    }
  }
  return { raw, viaComposite };
}

// Defaults declared by the composite, so the budget maths uses the same numbers
// the action actually applies when a caller passes nothing.
function compositeDefaults() {
  const inputs = parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8")).inputs || {};
  const num = (k, fallback) => Number((inputs[k] || {}).default ?? fallback);
  return {
    attempts: num("attempts", 3),
    timeoutSeconds: num("timeout-seconds", 420),
    finalTimeoutSeconds: num("final-timeout-seconds", 1200),
  };
}

// Worst case the step can take: (attempts-1) short bounds + one final bound, plus
// the escalating backoff BETWEEN attempts (15 s, 30 s, …) — leaving the backoff out
// under-reports the budget, which is the number this lint compares to a job timeout.
function worstCaseSeconds(withBlock, defaults) {
  const attempts = Number(withBlock.attempts ?? defaults.attempts);
  const early = Number(withBlock["timeout-seconds"] ?? defaults.timeoutSeconds);
  const final = Number(withBlock["final-timeout-seconds"] ?? defaults.finalTimeoutSeconds);
  let backoff = 0;
  for (let i = 1; i < attempts; i++) backoff += i * 15;
  return (attempts - 1) * early + final + backoff;
}

const { raw, viaComposite } = installSteps();

// Find steps by CONTENT, never by index: the action grew a step in front of the
// install (the apt dpkg-lock drop-in) and two assertions that used steps[0]
// silently started checking the wrong script.
function compositeStep(match) {
  const steps = parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8")).runs.steps;
  const found = steps.find((st) => match.test(String(st.run || "")));
  expect(found, `no composite step matching ${match} — did the action get restructured?`).toBeTruthy();
  return found;
}

test("every browser install goes through the bounded composite", () => {
  expect(
    raw,
    `these steps shell out to \`playwright install\` directly, so a slow apt mirror ` +
      `can stall them without limit (39 min measured). Replace the \`run:\` with ` +
      `\`uses: ./.cms-platform/.github/actions/${COMPOSITE_REF}\` — pass \`deps-only: "true"\` ` +
      `if the lane restored the browser binaries from cache and needs only the OS libraries.`,
  ).toEqual([]);
});

test("no caller's install budget can outlive its own job timeout", () => {
  // The bound is only useful if the step gets to REPORT hitting it. If the
  // composite's worst case exceeds the job's `timeout-minutes`, GitHub kills the
  // job mid-retry and the run says "job timed out" — losing the diagnostic that
  // says WHICH of a slow mirror vs a broken install it was. canary-prod's probe
  // job (timeout-minutes: 10) sat under a 21-min worst case until this check
  // existed; it now passes explicit smaller bounds.
  const defaults = compositeDefaults();
  const offenders = [];
  for (const c of viaComposite) {
    if (c.jobTimeoutMin == null) continue; // no cap declared ⇒ GitHub's 360 min
    const worst = worstCaseSeconds(c.with, defaults);
    if (worst >= c.jobTimeoutMin * 60) {
      offenders.push(`${c.where}: worst case ${Math.round(worst / 60)}min >= job timeout ${c.jobTimeoutMin}min`);
    }
  }
  expect(
    offenders,
    "these callers can be killed by their own job timeout while the install is still retrying. " +
      "Pass smaller `attempts` / `timeout-seconds` / `final-timeout-seconds`, or raise the job's " +
      "timeout-minutes above the composite's worst case.",
  ).toEqual([]);
});

test("the final attempt is more generous than the early ones", () => {
  // A uniform bound converts a sustained-slow mirror (the measured case: ~35 KB/s
  // for a whole run, 2340 s to finish) into a RED required check, which blocks a
  // cms/* canary PR permanently instead of merging it late — worse than the stall.
  // Early attempts abandon a bad connection fast; the LAST one must be able to
  // finish. apt and playwright both resume, so the attempts accumulate progress.
  const d = compositeDefaults();
  expect(
    d.finalTimeoutSeconds,
    "the last attempt must be allowed longer than the early ones, or a slow-but-fine mirror goes RED",
  ).toBeGreaterThan(d.timeoutSeconds);
});

test("the lint still sees the install lanes it polices", () => {
  // If a refactor renames the composite, this must fail loudly rather than
  // quietly pass with nothing left to check.
  expect(
    viaComposite.length,
    `no workflow step uses the ${COMPOSITE_REF} composite — did it get renamed?`,
  ).toBeGreaterThan(10);
});

test("the composite bounds each attempt and retries", () => {
  const body = String(compositeStep(/npx playwright/).run);

  expect(body, "the attempt must be wrapped in `timeout` or it is unbounded again").toMatch(
    /\btimeout\s+"\$bound"/,
  );
  expect(body, "the last attempt must pick up the generous bound").toMatch(
    /PW_INSTALL_FINAL_TIMEOUT_S/,
  );
  expect(body, "a bound with no retry turns a slow mirror into a red required check").toMatch(
    /PW_INSTALL_ATTEMPTS/,
  );
  // Regression guard on a bug this action shipped with in draft: after a `fi`
  // with no else branch, `$?` is the IF STATEMENT's status (always 0), not the
  // command's — so every failure logged as "exit 0" and the 124-vs-real-error
  // hint in the error message was wrong. Capture it with `|| status=$?`.
  expect(
    body,
    "capture the exit status with `|| status=$?`, never `$?` after a `fi` (always 0)",
  ).toMatch(/\|\|\s*status=\$\?/);
});

test("apt is told to WAIT for the dpkg lock, and retries back off", () => {
  // The most common apt failure on a GitHub-hosted runner is not a slow mirror —
  // it is losing a race for the dpkg lock to the runner's own boot-time apt-daily,
  // which exits 100. Retrying cannot fix that if the attempts are back-to-back:
  // all three land in the same lock window (measured, job 92892148211 — it failed
  // the webkit lane, failed the `e2e` gate, and BLOCKED the host loop's canary PR).
  // Two properties fix it: apt WAITS for the lock (a drop-in, because the apt-get
  // that matters is inside `playwright install`), and retries BACK OFF.
  const wf = parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8"));
  const steps = wf.runs.steps;
  const lockStep = steps.find((st) => /DPkg::Lock::Timeout/.test(String(st.run || "")));
  expect(lockStep, "no step configures DPkg::Lock::Timeout — a dpkg-lock race exits 100").toBeTruthy();
  expect(
    String(lockStep.run),
    "the drop-in must land in apt.conf.d so it reaches the apt inside `playwright install`",
  ).toMatch(/apt\.conf\.d/);

  const installStep = steps.find((st) => /npx playwright/.test(String(st.run || "")));
  expect(String(installStep.run), "retries must back off, not fire back-to-back").toMatch(
    /sleep\s+"\$backoff"/,
  );
});

test("the composite never interpolates its inputs into the shell command", () => {
  // The rendered `run:` is echoed to a public Actions log (AGENTS.md "Data
  // exposure in CI"), and an interpolated input is a script-injection vector.
  for (const step of parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8")).runs.steps) {
    expect(
      String(step.run),
      `step "${step.name}": inputs must reach the script via \`env:\`, not \`\${{ }}\` in \`run:\``,
    ).not.toMatch(/\$\{\{/);
  }
  const install = compositeStep(/npx playwright/);
  expect(
    Object.keys(install.env || {}).length,
    "the install script needs its inputs passed as env",
  ).toBeGreaterThan(3);
});
