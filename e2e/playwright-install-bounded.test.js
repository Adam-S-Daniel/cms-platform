// @lane: local — pure-fs workflow lint; no browser, no build, no network.
//
// Lint: no workflow may install Playwright browsers with a raw `npx playwright
// install` — every lane goes through the install-playwright-browsers composite,
// which splits the install into two phases and retries each.
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
// it late. Neither is a UNIFORM retry bound: when the network is slow for the
// whole run (the measured case), every attempt hits the same bound and the step
// still exits 1. What works for the DOWNLOAD is an ESCALATING budget — short
// early attempts to abandon a stalled connection, then one generous final
// attempt that can actually finish — kept under each caller's own job timeout so
// the diagnostic survives.
//
// And what does NOT work is bounding the APT phase (#210, job 92989057569).
// `timeout` signals only the process it launched, and the `apt-get` that matters
// is a grandchild: the bound killed `npx playwright install` mid-apt, `apt-get`
// survived holding /var/lib/dpkg/lock-frontend, and attempts 2 and 3 then died
// on "Could not get lock … held by process 2857 (apt-get)" — our own orphan.
// So the phases are split and only the download is bounded; the assertions
// below pin that asymmetry, because it reads like an oversight until you know.
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
          viaComposite.push({
            where,
            with: step.with || {},
            jobTimeoutMin: job["timeout-minutes"],
          });
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

// Worst case of the BOUNDED portion — the browser-download phase only:
// (attempts-1) short bounds + one final bound, plus the escalating backoff
// BETWEEN attempts (15 s, 30 s, …); leaving the backoff out under-reports the
// budget, which is the number this lint compares to a job timeout.
//
// The APT PHASE IS DELIBERATELY EXCLUDED, because it is unbounded (#210): there
// is no static number for "how long can apt take", so it cannot appear in a
// worst case at all. That is not a gap in this lint — the caller's own job
// `timeout-minutes` is apt's only backstop, and a job timeout there is an
// accurate report rather than the misleading one a killed apt produced. What
// this test still guarantees is the original property: the part of the step we
// DO bound cannot outlive the job, so the action always gets to print its
// diagnostic instead of being cut off mid-retry.
function boundedWorstCaseSeconds(withBlock, defaults) {
  if (String(withBlock["deps-only"]) === "true") return 0; // apt only ⇒ nothing bounded
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
  expect(
    found,
    `no composite step matching ${match} — did the action get restructured?`,
  ).toBeTruthy();
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

test("no caller's bounded install budget can outlive its own job timeout", () => {
  // The bound is only useful if the step gets to REPORT hitting it. If the
  // composite's bounded worst case exceeds the job's `timeout-minutes`, GitHub
  // kills the job mid-retry and the run says "job timed out" — losing the
  // diagnostic that says WHICH of a slow CDN vs a broken install it was.
  // canary-prod's probe job (timeout-minutes: 10) sat under a 21-min worst case
  // until this check existed; it now passes explicit smaller bounds.
  const defaults = compositeDefaults();
  const offenders = [];
  for (const c of viaComposite) {
    if (c.jobTimeoutMin == null) continue; // no cap declared ⇒ GitHub's 360 min
    const worst = boundedWorstCaseSeconds(c.with, defaults);
    if (worst >= c.jobTimeoutMin * 60) {
      offenders.push(
        `${c.where}: bounded worst case ${Math.round(worst / 60)}min >= job timeout ${c.jobTimeoutMin}min`,
      );
    }
  }
  expect(
    offenders,
    "these callers can be killed by their own job timeout while the download is still retrying. " +
      "Pass smaller `attempts` / `timeout-seconds` / `final-timeout-seconds`, or raise the job's " +
      "timeout-minutes above the composite's bounded worst case.",
  ).toEqual([]);
});

test("the final download attempt is more generous than the early ones", () => {
  // A uniform bound converts a sustained-slow network (the measured case: ~35 KB/s
  // for a whole run, 2340 s to finish) into a RED required check, which blocks a
  // cms/* canary PR permanently instead of merging it late — worse than the stall.
  // Early attempts abandon a bad connection fast; the LAST one must be able to
  // finish. The download resumes, so the attempts accumulate progress.
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

test("the apt phase is NOT wrapped in a timeout", () => {
  // THE #210 REGRESSION GUARD (measured, adamdaniel.ai run 31215846471, job
  // 92989057569). `timeout` signals only the process it launched, and the
  // `apt-get` that matters is a GRANDCHILD. A bound on the apt half therefore
  // does not abandon apt — it orphans it: attempt 1 was killed at its 420 s
  // bound, `apt-get` kept running and kept /var/lib/dpkg/lock-frontend, and
  // attempts 2 and 3 died on "Could not get lock … held by process 2857
  // (apt-get)". The bound starved its own retries, and a `dpkg` interrupted
  // mid-configure can leave packages half-configured on top of that. A slow apt
  // that FINISHES is strictly better; the job's `timeout-minutes` is the honest
  // backstop for one that never does.
  const body = String(compositeStep(/npx playwright/).run);

  const deps = body
    .split("\n")
    .filter((l) => /npx playwright install-deps\b/.test(l) && !/^\s*#/.test(l));
  expect(
    deps.length,
    "no `npx playwright install-deps` invocation found — did the two-phase split get undone?",
  ).toBeGreaterThan(0);
  for (const line of deps) {
    expect(
      line,
      `the apt phase must run UNBOUNDED — \`${line.trim()}\` puts it under a bound, which ` +
        `orphans apt-get on the dpkg lock and starves every retry (job 92989057569)`,
    ).not.toMatch(/\btimeout\b/);
  }
});

test("the download phase IS bounded, escalates, and retries", () => {
  const body = String(compositeStep(/npx playwright/).run);

  const download = body
    .split("\n")
    .filter(
      (l) =>
        /npx playwright install\b/.test(l) &&
        !/install-deps/.test(l) &&
        !/^\s*#/.test(l),
    );
  expect(
    download.length,
    "no plain `npx playwright install` invocation found — the browser download phase is missing",
  ).toBeGreaterThan(0);
  for (const line of download) {
    expect(
      line,
      "the download attempt must be wrapped in `timeout` or it is unbounded again (39 min measured)",
    ).toMatch(/\btimeout\s+"\$bound"/);
  }

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

test("both phases exist, and the download does not re-run apt", () => {
  // One `install --with-deps` cannot be bounded correctly: any bound on it can
  // land mid-apt, which is exactly the #210 orphan. The split is what makes
  // "bound the download, never apt" expressible, so `--with-deps` must not come
  // back — and phase B must not re-expose the dpkg lock phase A left clean.
  const body = String(compositeStep(/npx playwright/).run);
  expect(body, "phase A (apt) is missing").toMatch(/npx playwright install-deps "\$PW_INSTALL_BROWSER"/);
  expect(body, "phase B (browser download) is missing").toMatch(
    /npx playwright install "\$PW_INSTALL_BROWSER"/,
  );
  // Comment lines are stripped first: the script EXPLAINS why `--with-deps` is
  // gone, and the invariant is about what it RUNS, not what it says.
  const code = body
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  expect(
    code,
    "`--with-deps` fuses the phases back together, so any download bound can land mid-apt again (job 92989057569)",
  ).not.toMatch(/--with-deps/);
});

test("a failure is classified from the captured OUTPUT, not the exit code alone", () => {
  // `npx playwright install` wraps apt's exit 100 into exit 1, so the outer
  // status is NOT diagnostic. On job 92989057569 the log said "Could not get
  // lock /var/lib/dpkg/lock-frontend" while the step exited 1, and the old
  // message asserted "a real install failure (not a timeout, not an apt lock)" —
  // it named the one cause it had actually hit as the one thing it was not.
  const body = String(compositeStep(/npx playwright/).run);

  expect(
    body,
    "the attempt's combined output must be captured (`tee` keeps it streaming to the log too) " +
      "so the failure can be classified from what apt actually printed",
  ).toMatch(/\|\s*tee\s+"\$out"/);
  expect(
    body,
    "the classification must grep the captured output for the dpkg-lock signature — " +
      "the outer exit code cannot distinguish an apt lock from a broken package (exit 1 either way)",
  ).toMatch(/grep\s+-Eq/);
  expect(
    body,
    "the lock signature must include `lock-frontend` / `Could not get lock`, the strings apt prints",
  ).toMatch(/lock-frontend|Could not get lock/);
});

test("apt is told to WAIT for the dpkg lock, and retries back off", () => {
  // The most common apt failure on a GitHub-hosted runner is not a slow mirror —
  // it is losing a race for the dpkg lock to the runner's own boot-time apt-daily,
  // which exits 100. Retrying cannot fix that if the attempts are back-to-back:
  // all three land in the same lock window (measured, job 92892148211 — it failed
  // the webkit lane, failed the `e2e` gate, and BLOCKED the host loop's canary PR).
  // Two properties fix it: apt WAITS for the lock (a drop-in, because the apt-get
  // that matters is inside `playwright install-deps`), and retries BACK OFF.
  const wf = parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8"));
  const steps = wf.runs.steps;
  const lockStep = steps.find((st) => /DPkg::Lock::Timeout/.test(String(st.run || "")));
  expect(
    lockStep,
    "no step configures DPkg::Lock::Timeout — a dpkg-lock race exits 100",
  ).toBeTruthy();
  expect(
    String(lockStep.run),
    "the drop-in must land in apt.conf.d so it reaches the apt inside `playwright install-deps`",
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
