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

test("the consumer e2e matrix carries its own job wall, and its gate carries none", () => {
  // The budget check above skips a job with no `timeout-minutes` (GitHub then
  // applies its 360-minute default), so it cannot catch a MISSING wall. On the
  // consumer e2e matrix that gap is apt's only backstop gone: adamdaniel.ai PR
  // #4460's chromium-light lane sat in `apt-get update` for six hours until the
  // default cancelled it, holding the PR's auto-merge the whole time. The wall
  // belongs on the `project` matrix and never on the `e2e` gate, whose context
  // a wall would end `cancelled` (#289).
  const wf = parseYaml(
    fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", "e2e-tests.yml"), "utf8"),
  );
  const wall = wf.jobs.project["timeout-minutes"];
  expect(wall, "e2e-tests.yml's `project` job needs a `timeout-minutes` (apt's only backstop)").toBeGreaterThan(0);
  expect(wall, "keep the wall well under GitHub's 360-minute default").toBeLessThanOrEqual(60);
  expect(
    wf.jobs.e2e["timeout-minutes"],
    "the `e2e` gate publishes a required context, so it must carry no wall",
  ).toBeUndefined();
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

// ── The apt .deb cache (docs/E2E-PARALLELISM.md, "The apt tail, and the .deb
// cache that removes it") ─────────────────────────────────────────────────────
// Over 700 consumer project jobs the archive FETCH was 2 s at the median and
// 1558 s at the max; one webkit lane's 26-minute fetch kept canary PR #3921 from
// merging and failed the host loop. The cache removes the fetch without touching
// the apt invariants above, and it only helps if the DEFAULT branch saves it (a
// PR-scoped entry is invisible to every other PR; a canary branch gets one run).
function compositeSteps() {
  return parseYaml(fs.readFileSync(COMPOSITE_ACTION, "utf8")).runs.steps;
}

test("the .deb cache is restored and seeded BEFORE the apt phase, never around it", () => {
  const steps = compositeSteps();
  const idx = (pred, what) => {
    const i = steps.findIndex(pred);
    expect(i, `the composite has no ${what} step`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const restore = idx((s) => /^actions\/cache\/restore@[0-9a-f]{40}$/.test(String(s.uses || "")), "actions/cache/restore");
  const seed = idx((s) => /\/var\/cache\/apt\/archives/.test(String(s.run || "")) && /sudo cp/.test(String(s.run || "")), "seed");
  const apt = idx((s) => /npx playwright install-deps/.test(String(s.run || "")), "apt");
  const save = idx((s) => /^actions\/cache\/save@[0-9a-f]{40}$/.test(String(s.uses || "")), "actions/cache/save");
  expect(restore).toBeLessThan(seed);
  expect(seed, "the archive must be seeded before apt looks at it").toBeLessThan(apt);
  expect(save, "the save runs after apt has installed").toBeGreaterThan(apt);
  // The restore falls back to the newest entry for the same engine + Playwright,
  // then the same engine: a neighbouring runner image's .debs are nearly all
  // still valid (measured: 4.3 MB of 130 MB left to fetch across a rotation).
  const keys = String(steps[restore].with["restore-keys"]).trim().split("\n").map((l) => l.trim());
  expect(keys).toEqual(["${{ steps.debkey.outputs.prefix }}", "${{ steps.debkey.outputs.engine-prefix }}"]);
  // Fail-open everywhere: a failed cache step must never fail the lane.
  expect(steps[save]["continue-on-error"]).toBe(true);
  expect(String(steps[seed].run), "a failed seed must fall back to the mirror, not fail").toMatch(/\|\| echo "::warning::/);
});

test("only the caller's DEFAULT branch saves the .deb cache", () => {
  const steps = compositeSteps();
  const key = steps.find((s) => s.id === "debkey");
  expect(key, "the key step (id: debkey) decides whether this run saves").toBeTruthy();
  expect(key.env.DEFAULT_BRANCH).toBe("${{ github.event.repository.default_branch }}");
  const run = String(key.run);
  expect(run).toContain('"${GITHUB_REF:-}" = "refs/heads/${DEFAULT_BRANCH}"');
  // A schedule payload carries no `repository`; GitHub only runs schedules on the
  // default branch, so that event must count as it or the seeder never saves.
  expect(run).toContain('"${GITHUB_EVENT_NAME:-}" = "schedule"');
  expect(run).toContain('echo "save=${save}" >> "$GITHUB_OUTPUT"');
  // The key names what decides WHICH .debs apt wants.
  for (const part of ["${ImageOS", "${ImageVersion", "${PW_INSTALL_BROWSER}", "pw${pwv}"]) {
    expect(run, `the cache key must include ${part}`).toContain(part);
  }
  for (const s of steps.filter((st) => /^(Collect|Save) apt/.test(String(st.name)))) {
    expect(String(s.if), `${s.name} must be gated on the default-branch decision`).toContain(
      "steps.debkey.outputs.save == 'true'",
    );
    expect(String(s.if), `${s.name} must skip an exact hit (the entry already exists)`).toContain(
      "steps.debrestore.outputs.cache-hit != 'true'",
    );
  }
});

const SEEDER = "warm-e2e-apt-cache.yml";

test("the seeder warms every matrix engine, apt phase only, with no secrets", () => {
  const wf = parseYaml(fs.readFileSync(path.join(__dirname, "..", ".github", "workflows", SEEDER), "utf8"));
  const on = wf.on || wf[true];
  expect(Object.keys(on)).toEqual(["workflow_call"]);
  expect(on.workflow_call == null || on.workflow_call.secrets == null, "the seeder takes no secrets").toBe(true);
  // actions/cache authenticates with the runner's own cache token, so the
  // default token needs nothing beyond read access.
  expect(wf.permissions).toEqual({ contents: "read" });

  const list = wf.jobs.engines.steps.find((s) => s.id === "list");
  expect(String(list.run), "the engine list must come from ci-matrix.js, never a hand-written array").toContain(
    "node ci-matrix.js --engines",
  );
  const warm = wf.jobs.warm;
  expect(warm.strategy.matrix.engine).toBe("${{ fromJSON(needs.engines.outputs.engines) }}");
  expect(warm.strategy["fail-fast"]).toBe(false);
  const step = warm.steps.find((s) => String(s.uses || "").includes(COMPOSITE_REF));
  expect(step.with.browser).toBe("${{ matrix.engine }}");
  expect(String(step.with["deps-only"]), "the browser download is not cached; warm apt only").toBe("true");
  for (const [id, job] of Object.entries(wf.jobs)) {
    expect(job["timeout-minutes"], `${id} needs a job timeout (apt's only backstop)`).toBeGreaterThan(0);
  }
});

test("the seeder's thin caller runs daily and on demand, never on a PR", () => {
  const caller = parseYaml(
    fs.readFileSync(path.join(__dirname, "..", "examples", "site", ".github", "workflows", SEEDER), "utf8"),
  );
  const on = caller.on || caller[true];
  expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(on.schedule.length).toBe(1);
  expect(caller.permissions).toEqual({ contents: "read" });
  expect(String(caller.jobs.warm.uses)).toMatch(
    new RegExp(`^Adam-S-Daniel/cms-platform/\\.github/workflows/${SEEDER.replace(".", "\\.")}@v\\d+\\.\\d+\\.\\d+$`),
  );
});

// ── Mirror-independent apt (docs/E2E-PARALLELISM.md, 2026-10-22) ────────────
// Run 39851509261's chromium-desktop-3k shard 3/3 restored an EXACT .deb cache
// hit and then sat 44 minutes in the `apt-get update` that `install-deps`
// always runs, until the 45-minute job wall cancelled it. Two changes: an exact
// hit installs the cached .debs offline (no update, no mirror), and apt's own
// transport abandons an idle fetch. These tests run the composite's REAL bash
// against stub `npx`/`sudo`/`apt-get`/`dpkg`/`timeout`/`sleep`/`id` binaries
// placed first on PATH, so they assert what the script DOES, not how it is
// spelled. No stub signals anything and `sleep` returns at once.
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const STUBS = {
  // Every stub appends one line to $STUB_LOG, then behaves per its env knob.
  npx: `echo "npx $*" >> "$STUB_LOG"
case "$*" in
  *"install-deps --dry-run"*) exit "\${STUB_DRYRUN_RC:-0}" ;;
  *"install-deps"*) exit "\${STUB_ONLINE_RC:-0}" ;;
  *) exit 0 ;;
esac`,
  sudo: `echo "sudo $*" >> "$STUB_LOG"
exec "$@"`,
  "apt-get": `echo "apt-get $*" >> "$STUB_LOG"
exit "\${STUB_APT_RC:-0}"`,
  dpkg: `echo "dpkg $*" >> "$STUB_LOG"
if [ "$1" = "--audit" ]; then printf '%s' "\${STUB_AUDIT:-}"; fi
exit 0`,
  // Positive control for the no-timeout invariant: the download phase MUST
  // reach this stub, so a run that logs no timeout call at all is broken.
  timeout: `echo "timeout $*" >> "$STUB_LOG"
shift
exec "$@"`,
  sleep: `echo "sleep $*" >> "$STUB_LOG"`,
  id: `echo 1001`,
};

function runInstallStep(env) {
  const step = compositeStep(/npx playwright/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-install-step-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const [name, body] of Object.entries(STUBS)) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    }
    const debDir = path.join(dir, "debs");
    fs.mkdirSync(debDir);
    for (const f of ["libnss3_3.98_amd64.deb", "xvfb_21.1_amd64.deb"]) fs.writeFileSync(path.join(debDir, f), "");
    const script = path.join(dir, "step.sh");
    fs.writeFileSync(script, String(step.run));
    const log = path.join(dir, "log");
    fs.writeFileSync(log, "");
    const r = spawnSync("bash", [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        STUB_LOG: log,
        PW_INSTALL_BROWSER: "chromium",
        PW_INSTALL_DEPS_ONLY: "false",
        PW_INSTALL_ATTEMPTS: "3",
        PW_INSTALL_TIMEOUT_S: "420",
        PW_INSTALL_FINAL_TIMEOUT_S: "1200",
        PW_APT_LOCK_TIMEOUT_S: "300",
        PW_APT_DEB_CACHE: "true",
        PW_APT_DEB_DIR: debDir,
        PW_APT_EXACT_HIT: "",
        PW_APT_MATCHED_KEY: "",
        ...env,
      },
    });
    return {
      status: r.status,
      out: `${r.stdout}${r.stderr}`,
      calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const isOffline = (c) => /^apt-get install .*--no-download/.test(c);
const isOnline = (c) => /^npx playwright install-deps chromium$/.test(c);
const isUpdate = (c) => /^apt-get update/.test(c);

const SCENARIOS = {
  "exact hit": { PW_APT_EXACT_HIT: "true", PW_APT_MATCHED_KEY: "k-exact" },
  "exact hit, offline apt fails": { PW_APT_EXACT_HIT: "true", PW_APT_MATCHED_KEY: "k-exact", STUB_APT_RC: "100" },
  "exact hit, offline apt fails, dpkg left unconfigured": {
    PW_APT_EXACT_HIT: "true",
    PW_APT_MATCHED_KEY: "k-exact",
    STUB_APT_RC: "100",
    STUB_AUDIT: "The following packages are only half configured",
  },
  "exact hit, Playwright still reports missing deps": {
    PW_APT_EXACT_HIT: "true",
    PW_APT_MATCHED_KEY: "k-exact",
    STUB_DRYRUN_RC: "1",
  },
  "restore-keys fallback": { PW_APT_EXACT_HIT: "false", PW_APT_MATCHED_KEY: "k-older-image" },
  miss: { PW_APT_EXACT_HIT: "false", PW_APT_MATCHED_KEY: "" },
  "cache disabled": { PW_APT_DEB_CACHE: "false", PW_APT_EXACT_HIT: "", PW_APT_DEB_DIR: "" },
};

test("an EXACT cache hit installs the cached .debs offline: no apt-get update, no install-deps", () => {
  const r = runInstallStep(SCENARIOS["exact hit"]);
  expect(r.status, r.out).toBe(0);
  const offline = r.calls.filter(isOffline);
  expect(offline.length, `the cached .debs must be installed with --no-download\n${r.calls.join("\n")}`).toBe(1);
  // By PATH, not by name: names resolve against the image's stale lists (22 of
  // 109 chromium .debs mismatched with 7-week-old lists, so names exited 100).
  expect(offline[0]).toMatch(
    /--no-install-recommends --no-download \S+\/libnss3_3\.98_amd64\.deb \S+\/xvfb_21\.1_amd64\.deb$/,
  );
  expect(r.calls.filter(isOnline), "the online install-deps must not run after a good offline install").toEqual([]);
  expect(r.calls.filter(isUpdate), "the offline path never refreshes the index").toEqual([]);
  // Success is Playwright's own verdict, taken AFTER the install.
  const verify = r.calls.indexOf("npx playwright install-deps --dry-run chromium");
  expect(verify, "the offline install must be verified by `install-deps --dry-run`").toBeGreaterThan(
    r.calls.findIndex(isOffline),
  );
  expect(r.out).toContain("apt path: offline (exact cache hit)");
});

for (const name of ["restore-keys fallback", "miss", "cache disabled"]) {
  test(`no offline install without an exact hit: ${name}`, () => {
    const r = runInstallStep(SCENARIOS[name]);
    expect(r.status, r.out).toBe(0);
    expect(r.calls.filter(isOffline), r.calls.join("\n")).toEqual([]);
    expect(r.calls.filter(isOnline).length, "today's online path must run").toBe(1);
    expect(r.out).toMatch(/apt path: online \((partial cache hit|cache miss|the apt \.deb cache is disabled)/);
  });
}

for (const name of [
  "exact hit, offline apt fails",
  "exact hit, offline apt fails, dpkg left unconfigured",
  "exact hit, Playwright still reports missing deps",
]) {
  test(`a failed offline install falls back to the unchanged online path: ${name}`, () => {
    const r = runInstallStep(SCENARIOS[name]);
    expect(r.status, `fail-open: the lane must still go green\n${r.out}`).toBe(0);
    const off = r.calls.findIndex(isOffline);
    const on = r.calls.findIndex(isOnline);
    expect(off, r.calls.join("\n")).toBeGreaterThanOrEqual(0);
    expect(on, "the online install-deps must run after an offline failure").toBeGreaterThan(off);
    expect(r.out).toMatch(/apt path: online \(offline failed: /);
    const repair = r.calls.indexOf("dpkg --configure -a");
    if (name.includes("unconfigured")) {
      expect(repair, "an unconfigured dpkg must be finished BEFORE the online apt").toBeGreaterThan(off);
      expect(repair).toBeLessThan(on);
    } else {
      expect(repair, "dpkg is only repaired when `dpkg --audit` reports something").toBe(-1);
    }
  });
}

test("nothing that runs apt or dpkg is ever wrapped in `timeout`, on any path", () => {
  // The #210 invariant, asserted on what the script EXECUTES: across every
  // path, `timeout` may wrap only the browser download.
  let sawDownloadBound = false;
  for (const [name, env] of Object.entries(SCENARIOS)) {
    const r = runInstallStep(env);
    for (const c of r.calls.filter((x) => x.startsWith("timeout "))) {
      expect(c, `${name}: \`${c}\` puts apt under a bound (job 92989057569)`).not.toMatch(/apt-get|dpkg|install-deps/);
      if (/^timeout \d+ npx playwright install chromium$/.test(c)) sawDownloadBound = true;
    }
  }
  expect(sawDownloadBound, "positive control: the download phase must reach the timeout stub").toBe(true);
});

test("apt's own transport abandons an idle fetch: Acquire timeouts in the same drop-in, Retries left to the image", () => {
  // Written next to DPkg::Lock::Timeout so they reach the apt-get INSIDE
  // `playwright install-deps`. An inactivity timeout, so it never abandons the
  // measured slow-but-flowing mirror; it cannot catch a trickle either.
  const step = compositeSteps().find((st) => /DPkg::Lock::Timeout/.test(String(st.run || "")));
  const run = String(step.run);
  const val = (key) => {
    const m = run.match(new RegExp(`'${key.replace(/[.:]/g, "\\$&")} "(\\d+)";'`));
    expect(m, `the apt.conf.d drop-in must set ${key}`).toBeTruthy();
    return Number(m[1]);
  };
  for (const key of ["Acquire::http::Timeout", "Acquire::https::Timeout"]) {
    const s = val(key);
    expect(s, `${key}: above a healthy mirror's longest silence`).toBeGreaterThanOrEqual(10);
    expect(s, `${key}: below apt's 30 s default, or it buys nothing`).toBeLessThan(30);
  }
  // The hosted image sets `Acquire::Retries "1"` on purpose: apt spends every
  // retry on the same URI before trying the next mirror in apt-mirrors.txt
  // (actions/runner-images#14594). A higher count here would delay that
  // failover wherever this drop-in wins.
  expect(run, "leave Acquire::Retries to the runner image (mirror failover)").not.toMatch(/Acquire::Retries\s+"/);
});

test("the offline path reads the EXACT-hit output, and every cache step is fail-open", () => {
  const steps = compositeSteps();
  const install = compositeStep(/npx playwright/);
  // `cache-hit` is 'true' only for the primary key; restore-keys report 'false'.
  expect(install.env.PW_APT_EXACT_HIT).toBe("${{ steps.debrestore.outputs.cache-hit }}");
  expect(install.env.PW_APT_DEB_DIR).toBe("${{ steps.debkey.outputs.dir }}");
  const cacheActions = steps.filter((st) => /^actions\/cache\/(restore|save)@/.test(String(st.uses || "")));
  expect(cacheActions.length).toBe(2);
  for (const s of cacheActions) {
    expect(s["continue-on-error"], `${s.uses}: a cache-service error must never fail the lane`).toBe(true);
  }
  // The cache's own bash steps never abort: no `set -e`, no nonzero exit.
  const bashCacheSteps = steps.filter((st) => st.id === "debkey" || /^(Seed|Collect) apt/.test(String(st.name)));
  expect(bashCacheSteps.length).toBe(3);
  for (const s of bashCacheSteps) {
    const code = String(s.run)
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    expect(code, `${s.name}: set -e turns a cache hiccup into a red lane`).not.toMatch(/set -[a-z]*e/);
    expect(code, `${s.name}: must not exit nonzero`).not.toMatch(/\bexit [1-9]/);
  }
});
