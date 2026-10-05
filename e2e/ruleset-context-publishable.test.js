// @lane: local — every REQUIRED status-check context must be one something publishes (#371)
//
// ── The defect ─────────────────────────────────────────────────────────────
// `repo-settings.yml`'s `ruleset_library.cms-feature-branches` required the
// context `validate-content`. Nothing publishes that string. A consumer's
// `cms-editorial-workflow.yml` thin caller declares job id `editorial`, which
// `uses:` the platform reusable whose job id is `validate-content`, and GitHub
// publishes the resulting check run as `editorial / validate-content` — which
// is exactly how `consumer-main`, in the same file, spells the same check.
//
// A required context that nothing reports never turns green, and a branch
// ruleset does not time out. Every PR into a `cms/**`, `claude/**`, `feat/**`,
// … base on either consumer was therefore permanently `mergeable_state:
// blocked`, with no error raised anywhere — the failure is a silence.
//
// That is the server half of cms-platform#371. A CMS edit made on a PR-preview
// deploy opens its editorial PR against the preview's own feature branch (
// `scripts/patch-preview-config.sh` rewrites the preview admin's
// `backend.branch` on purpose), so it lands on exactly those refs. Measured on
// jodidaniel.com#233: `editorial / auto-merge-when-ready` armed native
// auto-merge at 22:05:25, `editorial / validate-content` went green at
// 22:06:27, and the PR was still open and unmerged twenty minutes later, when a
// human with the admin bypass (`bypass_actors` actor_id 5) merged it by hand.
// An editor watching `/admin` got every success signal the product has and the
// change never landed.
//
// ── Why the whole class needs a lint and not just a one-line fix ───────────
// The two halves of this invariant live in different files, are written in
// different vocabularies, and neither is executable. Nothing else in the repo
// joins a required-context STRING to the workflow that would have to emit it:
// `cms-automerge-nudge.test.js` compares the nudge's `required_contexts` input
// against `consumer-main`, which locks two lists to EACH OTHER — both of them
// could name a context nothing publishes and that lint would stay green.
//
// Note also that this is a latent defect regardless of what is live right now.
// `scripts/audit-repo-settings.js --fix --yes` PUTs this manifest, so an
// unpublishable context here becomes an unpublishable context live at the next
// reconcile, whatever the current drift.
//
// ── The oracle ────────────────────────────────────────────────────────────
// GitHub names a check run after the JOB that produced it: `<job>` for a job
// that runs steps, and `<caller job> / <called job>` for a job that `uses:` a
// reusable workflow. So the publishable set is computable from the workflow
// tree, per repo:
//
//   Adam-S-Daniel/cms-platform  → its OWN `.github/workflows/`, minus the
//                                 `workflow_call`-only reusables, which cannot
//                                 run standalone and so publish nothing here.
//   a consumer                  → `examples/site/.github/workflows/` (the
//                                 consumer-dictated thin-caller set), with each
//                                 `uses:` resolved into the platform reusable it
//                                 names, one join deep.
//
// `repos:` says which rulesets each repo carries, so each ruleset is checked
// against the oracle of the repos that actually use it.
//
// It PARSES, per the house rule (AGENTS.md, "AST always, never regex"). A line
// scan is not merely brittle here, it is wrong: the join that turns
// `validate-content` into `editorial / validate-content` is a relation BETWEEN
// two files, invisible to any amount of scanning of either one.
const { test, expect } = require("./base");
const fs = require("node:fs");
const path = require("node:path");
const { parseYaml, events } = require("./workflow-yaml-utils");

const REPO_ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(REPO_ROOT, "repo-settings.yml");
const PLATFORM_WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");
const CONSUMER_WORKFLOWS = path.join(
  REPO_ROOT,
  "examples",
  "site",
  ".github",
  "workflows",
);
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";

function readWorkflowDir(dir) {
  return fs
    .readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => ({ file: f, doc: parseYaml(fs.readFileSync(path.join(dir, f), "utf8")) }))
    .filter((w) => w.doc && typeof w.doc === "object");
}

// GitHub labels a job by its `name:` when there is one, else by its id. A
// `name:` carrying a `${{ }}` expression is not a fixed string, so the id is
// the only stable thing to match on — and a required context could not sanely
// name the interpolated form anyway.
function jobLabel(id, job) {
  const name = job && typeof job.name === "string" ? job.name : null;
  return name && !name.includes("${{") ? name : id;
}

// The reusable a caller job points at, as a path inside THIS repo, or null for
// a job that runs its own steps (or calls something we do not own).
function platformReusableFor(job) {
  const uses = job && typeof job.uses === "string" ? job.uses : null;
  if (!uses) return null;
  const marker = "/.github/workflows/";
  const at = uses.indexOf(marker);
  if (at === -1 || !/cms-platform/.test(uses.slice(0, at))) return null;
  const file = uses.slice(at + marker.length).split("@")[0];
  const full = path.join(PLATFORM_WORKFLOWS, file);
  return fs.existsSync(full) ? full : null;
}

function jobsOf(doc) {
  return doc && doc.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
}

// Contexts a consumer's PRs can carry: the thin-caller set, each `uses:` joined
// one level into the platform reusable it names.
function consumerContexts() {
  const out = new Map();
  for (const { file, doc } of readWorkflowDir(CONSUMER_WORKFLOWS)) {
    for (const [id, job] of Object.entries(jobsOf(doc))) {
      const reusable = platformReusableFor(job);
      const caller = jobLabel(id, job);
      if (!reusable) {
        out.set(caller, file);
        continue;
      }
      const inner = parseYaml(fs.readFileSync(reusable, "utf8"));
      for (const [rid, rjob] of Object.entries(jobsOf(inner))) {
        out.set(`${caller} / ${jobLabel(rid, rjob)}`, `${file} → ${path.basename(reusable)}`);
      }
    }
  }
  return out;
}

// A workflow's `on:` value. A BARE `on:` key parses to the boolean `true` under
// a YAML 1.1 schema, which lands the triggers under the "true" property.
function onOf(doc) {
  return doc.on !== undefined ? doc.on : doc.true;
}

// The platform's OWN callers name a reusable by a LOCAL path
// (`./.github/workflows/secrets-scan.yml` — self-secrets-scan.yml,
// self-dependabot-auto-merge.yml). `platformReusableFor` above deliberately does
// not resolve that spelling: in a consumer's caller `./` is the CONSUMER's tree.
function localReusableFor(job) {
  const uses = job && typeof job.uses === "string" ? job.uses : null;
  const m = uses && /^\.\/\.github\/workflows\/([^@\s]+)$/.exec(uses);
  if (!m) return null;
  const full = path.join(PLATFORM_WORKFLOWS, m[1]);
  return fs.existsSync(full) ? full : null;
}

// Every check run the platform repo's own workflows can publish, one entry per
// (context, publishing job): `{ context, file, jobId, job, reusableJob, on }`.
// A `workflow_call`-only workflow is a reusable: it never runs on this repo's
// PRs, so it publishes nothing here (docs/CONTRIBUTING.md, "In `cms-platform`
// itself, most workflows are `workflow_call`-only reusables").
//
// A caller job that `uses:` a local reusable publishes `<caller> / <called>`
// and NEVER the bare `<caller>`. Until #525 this oracle emitted the bare
// caller label for such a job, so it listed `scan` (which nothing publishes)
// and not `scan / scan` (which self-secrets-scan.yml does): the bare `scan`
// #525's issue text named would have passed this lint and then blocked every
// PR to main forever, while the real `scan / scan` would have failed it.
function platformPublishers() {
  const out = [];
  for (const { file, doc } of readWorkflowDir(PLATFORM_WORKFLOWS)) {
    const on = onOf(doc);
    const triggers = events(on);
    if (triggers.length === 1 && triggers[0] === "workflow_call") continue;
    for (const [jobId, job] of Object.entries(jobsOf(doc))) {
      const caller = jobLabel(jobId, job);
      if (job && typeof job.uses === "string") {
        // A `uses:` this oracle cannot read publishes nothing it can name — so
        // a context that depends on one stays unresolved (and fails) rather
        // than resolving to a bare caller label that is never reported.
        const reusable = localReusableFor(job);
        if (!reusable) continue;
        const inner = parseYaml(fs.readFileSync(reusable, "utf8"));
        for (const [rid, rjob] of Object.entries(jobsOf(inner))) {
          out.push({
            context: `${caller} / ${jobLabel(rid, rjob)}`,
            file: `${file} → ${path.basename(reusable)}`,
            jobId,
            job,
            reusableJob: rjob,
            on,
          });
        }
        continue;
      }
      out.push({ context: caller, file, jobId, job, reusableJob: null, on });
    }
  }
  return out;
}

function platformContexts() {
  return new Map(platformPublishers().map((p) => [p.context, p.file]));
}

// ── "Reported on EVERY pull request to main" (#525) ───────────────────────
//
// Publishable is not enough for a REQUIRED context: it must be reported on
// every PR into the protected branch, including a PR that touches nothing the
// job cares about. A `paths:` filter, a `branches:` list without main, a
// `types:` list missing `opened`/`synchronize`/`reopened`, or a job-level `if:`
// each leave some PR with no check run — a caller job skipped by `if:` emits
// no `<caller> / <called>` run at all (#222) — and a required context that is
// never reported blocks the merge forever. The fleet remedy for a costly job
// is a broad trigger plus an early "salient changes?" step gating later STEPS,
// so the job still reports.
//
// `continue-on-error` is checked here too: on a required job it makes the
// verdict the ruleset reads something other than whether the work passed.

const PROTECTED_BRANCH = "main";
const REQUIRED_PR_TYPES = ["opened", "synchronize", "reopened"];

function listOf(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

// GitHub's branch-filter glob, enough of it to answer "does this match main":
// `**` crosses `/`, `*` does not, `?` is one character. A `!` negation can
// only be judged against the rest of the list, so it is reported, not guessed.
function globMatches(pattern, branch) {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(branch);
}

// Why a workflow with this `on:` might NOT run on some pull request to main.
// Empty means it runs on every one.
function pullRequestTriggerGaps(on) {
  if (!events(on).includes("pull_request")) return ["no `pull_request` trigger"];
  const cfg = on && typeof on === "object" && !Array.isArray(on) ? on.pull_request : null;
  if (!cfg || typeof cfg !== "object") return [];
  const gaps = [];
  for (const key of ["paths", "paths-ignore"]) {
    if (key in cfg) gaps.push(`\`on.pull_request.${key}\` skips PRs that touch no matching path`);
  }
  const branches = listOf(cfg.branches);
  if ("branches" in cfg) {
    if (branches.some((b) => b.startsWith("!"))) {
      gaps.push("`on.pull_request.branches` has a `!` negation this lint cannot evaluate");
    } else if (!branches.some((b) => globMatches(b, PROTECTED_BRANCH))) {
      gaps.push(`\`on.pull_request.branches\` does not match \`${PROTECTED_BRANCH}\``);
    }
  }
  if (listOf(cfg["branches-ignore"]).some((b) => globMatches(b, PROTECTED_BRANCH))) {
    gaps.push(`\`on.pull_request.branches-ignore\` matches \`${PROTECTED_BRANCH}\``);
  }
  if ("types" in cfg) {
    const types = listOf(cfg.types);
    for (const t of REQUIRED_PR_TYPES) {
      if (!types.includes(t)) gaps.push(`\`on.pull_request.types\` omits \`${t}\``);
    }
  }
  return gaps;
}

// The ONE job-level `if:` that cannot skip a publisher: a gate with `needs:`
// whose condition is exactly `always()` (#527's `fixture-e2e`). That is the
// shape required-context-cancellable.test.js DEMANDS of a gate — without it the
// gate skips whenever the job it needs fails — so this lint must accept it, but
// only verbatim: `always() && <clause>` can still be false, and a bare
// `always()` on a job with no `needs:` is noise this lint keeps flagging.
function isAlwaysGate(j) {
  if (!j || !("needs" in j) || typeof j.if !== "string") return false;
  const cond = j.if.trim().replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  return cond === "always()";
}

// Why this publishing job might be skipped, or report a verdict that is not
// its work's.
function publisherJobGaps({ job, reusableJob }) {
  const gaps = [];
  for (const [where, j] of [
    ["job", job],
    ["reusable job", reusableJob],
  ]) {
    if (!j || typeof j !== "object") continue;
    if ("if" in j && !isAlwaysGate(j)) {
      gaps.push(`${where}-level \`if:\` can skip it, and a skip reports no verdict`);
    }
    if ("continue-on-error" in j && j["continue-on-error"] !== false) {
      gaps.push(`${where}-level \`continue-on-error\` — the required verdict is not the work's`);
    }
  }
  return gaps;
}

// PR-time jobs that are deliberately NOT required, keyed `<file>#<job id>`. The
// fleet rule is that every CI job on pull requests is a required check unless
// the repo documents why not; this map is that documentation, and the test
// below fails on any PR-time job missing from both it and the ruleset.
const NOT_REQUIRED_PR_JOBS = {
  "self-dependabot-auto-merge.yml#auto-merge":
    "an ACTUATOR, not a verdict: it arms native auto-merge on Dependabot PRs and is skipped " +
    "(the reusable job's `if: github.actor == 'dependabot[bot]'`) on every other PR, so " +
    "requiring it would gate merges on a job that checks nothing.",
  "self-fixture-e2e.yml#fixture-e2e-project":
    "the WORK half of a work/gate split (#527): its two matrix legs carry the " +
    "`timeout-minutes` wall the browser install needs, and a job killed at its wall reports " +
    "`cancelled`, which no merge can get past (#289). The required context is the " +
    "`fixture-e2e` gate in the same file, which fails unless every leg succeeded.",
  "repo-settings-pat-verify.yml#verify":
    "a LIVE credential probe that runs only when its own workflow file changes " +
    "(`paths:`) and needs the REPO_SETTINGS_READ_* secrets, which a fork or Dependabot PR " +
    "does not get — required, it would block every PR that does not touch that file.",
};

function requiredContextSet(m, repo) {
  const out = new Set();
  for (const rulesetName of Object.values(((m.repos || {})[repo] || {}).rulesets || {})) {
    const ruleset = (m.ruleset_library || {})[rulesetName];
    if (!ruleset) continue;
    for (const c of requiredContextsOf(ruleset)) out.add(c);
  }
  return out;
}

function manifest() {
  return parseYaml(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

function requiredContextsOf(ruleset) {
  const out = [];
  for (const rule of ruleset.rules || []) {
    if (rule.type !== "required_status_checks") continue;
    for (const c of (rule.parameters && rule.parameters.required_status_checks) || []) {
      if (c && typeof c.context === "string") out.push(c.context);
    }
  }
  return out;
}

test.describe("repo-settings.yml required contexts are publishable", () => {
  test("every required context is a check run some workflow can actually report", () => {
    const m = manifest();
    const consumer = consumerContexts();
    const platform = platformContexts();

    expect(consumer.size, "consumer thin-caller contexts resolved").toBeGreaterThan(0);
    expect(platform.size, "platform self-CI contexts resolved").toBeGreaterThan(0);

    const unpublishable = [];
    for (const [repo, cfg] of Object.entries(m.repos || {})) {
      const oracle = repo === PLATFORM_REPO ? platform : consumer;
      const which = repo === PLATFORM_REPO ? "the platform's own workflows" : "examples/site";
      for (const [slot, rulesetName] of Object.entries((cfg && cfg.rulesets) || {})) {
        const ruleset = (m.ruleset_library || {})[rulesetName];
        expect(ruleset, `ruleset_library.${rulesetName} (referenced by ${repo}.${slot})`).toBeTruthy();
        for (const ctx of requiredContextsOf(ruleset)) {
          if (!oracle.has(ctx)) unpublishable.push({ repo, rulesetName, ctx, which });
        }
      }
    }

    expect(
      unpublishable,
      unpublishable.length
        ? `A required status check whose context nothing publishes can never go green, and a\n` +
          `branch ruleset does not time out — every PR onto those refs blocks forever, silently\n` +
          `(cms-platform#371). Offenders:\n` +
          unpublishable
            .map(
              (u) =>
                `  ${u.repo} → ruleset_library.${u.rulesetName} requires "${u.ctx}", which no ` +
                `job in ${u.which} publishes.`,
            )
            .join("\n") +
          `\n\nA check run is named "<job>" for a job with steps and "<caller job> / <called job>"\n` +
          `for a job that \`uses:\` a reusable. Contexts that ARE publishable by examples/site:\n` +
          [...consumerContexts().keys()].sort().map((c) => `  ${c}`).join("\n")
        : "",
    ).toEqual([]);
  });

  // The bare caller label of a `uses:` job is the shape #525's issue text
  // proposed (`scan`), and nothing publishes it.
  test("the platform oracle joins LOCAL reusable calls (`scan / scan`, never bare `scan`)", () => {
    const platform = platformContexts();
    expect(platform.has("scan / scan"), "self-secrets-scan.yml must resolve to `scan / scan`").toBe(
      true,
    );
    expect(
      platform.has("scan"),
      "a bare `scan` must NOT be publishable — self-secrets-scan.yml's `scan` job calls a " +
        "reusable, so GitHub reports `scan / scan` and never `scan`",
    ).toBe(false);
  });

  // A ruleset no repo references is checked against nothing above, so it could
  // carry an unpublishable context indefinitely and this lint would pass.
  test("every ruleset_library entry is referenced by at least one repo", () => {
    const m = manifest();
    const referenced = new Set();
    for (const cfg of Object.values(m.repos || {})) {
      for (const name of Object.values((cfg && cfg.rulesets) || {})) referenced.add(name);
    }
    const orphans = Object.keys(m.ruleset_library || {}).filter((n) => !referenced.has(n));
    expect(
      orphans,
      `ruleset_library entries no repo in \`repos:\` references: ${orphans.join(", ")}. ` +
        `Nothing applies them and the publishable-context check above cannot reach them — ` +
        `either map them to a repo or delete them.`,
    ).toEqual([]);
  });

  // The join above is what makes the lint meaningful; if `uses:` resolution
  // silently stopped working, every context would look unpublishable OR the
  // oracle would collapse to bare job ids and the original defect would pass.
  test("the oracle actually resolves reusable calls, not just caller job ids", () => {
    const consumer = consumerContexts();
    const joined = [...consumer.keys()].filter((c) => c.includes(" / "));
    expect(joined.length, "joined `<caller> / <called>` contexts resolved").toBeGreaterThan(5);
    expect(
      consumer.has("editorial / validate-content"),
      "the editorial thin caller must resolve to `editorial / validate-content` — the context " +
        "both consumer-main and cms-feature-branches require",
    ).toBe(true);
    expect(
      consumer.has("validate-content"),
      "a bare `validate-content` must NOT be publishable — if it ever is, the #371 defect " +
        "stops being detectable by this lint",
    ).toBe(false);
  });
});

test.describe("platform-main: required contexts and PR-time jobs cannot drift apart (#525)", () => {
  test("every required context is reported, with a real verdict, on EVERY pull request to main", () => {
    const m = manifest();
    const required = [...requiredContextSet(m, PLATFORM_REPO)];
    expect(required.length, `${PLATFORM_REPO}'s required contexts resolved`).toBeGreaterThan(0);
    const publishers = platformPublishers();

    const offenders = [];
    for (const ctx of required) {
      const onPr = publishers.filter(
        (p) => p.context === ctx && events(p.on).includes("pull_request"),
      );
      if (onPr.length === 0) {
        offenders.push(`"${ctx}": no workflow with a \`pull_request\` trigger publishes it`);
        continue;
      }
      for (const p of onPr) {
        for (const gap of [...pullRequestTriggerGaps(p.on), ...publisherJobGaps(p)]) {
          offenders.push(`"${ctx}" (${p.file}, job \`${p.jobId}\`): ${gap}`);
        }
      }
    }
    expect(
      offenders,
      `A required context must be reported on every PR to ${PROTECTED_BRANCH}, and its verdict ` +
        `must be the work's. One that is filtered out or skipped is never reported, and the ` +
        `merge waits on it forever. Keep the trigger broad and gate later STEPS on an early ` +
        `"salient changes?" step instead. Offenders:\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });

  test("every job a pull request runs here is required, or exempt with a stated reason", () => {
    const m = manifest();
    const required = requiredContextSet(m, PLATFORM_REPO);
    const prJobs = platformPublishers().filter((p) => events(p.on).includes("pull_request"));
    expect(prJobs.length, "PR-time jobs resolved").toBeGreaterThan(0);

    const unlisted = prJobs.filter(
      (p) => !required.has(p.context) && !NOT_REQUIRED_PR_JOBS[`${p.file.split(" → ")[0]}#${p.jobId}`],
    );
    expect(
      unlisted.map((p) => `"${p.context}" (${p.file}, job \`${p.jobId}\`)`),
      `These jobs run on pull requests but are neither required by ruleset_library's ` +
        `${PLATFORM_REPO} ruleset nor listed in NOT_REQUIRED_PR_JOBS. A non-required check ` +
        `cannot block a merge, so a red one is a warning nobody has to read. Add the context to ` +
        `repo-settings.yml (after confirming the name GitHub reports on a real PR), or add a ` +
        `NOT_REQUIRED_PR_JOBS entry saying why not.`,
    ).toEqual([]);

    // A stale or contradictory exemption is a hole: it would silently excuse
    // the next job that reuses the key.
    for (const [key, why] of Object.entries(NOT_REQUIRED_PR_JOBS)) {
      expect(why.length, `${key}: an exemption must say why`).toBeGreaterThan(20);
      const matches = prJobs.filter((p) => `${p.file.split(" → ")[0]}#${p.jobId}` === key);
      expect(matches.length, `NOT_REQUIRED_PR_JOBS["${key}"] matches no PR-time job`).toBeGreaterThan(
        0,
      );
      for (const p of matches) {
        expect(
          required.has(p.context),
          `NOT_REQUIRED_PR_JOBS["${key}"] exempts "${p.context}", which the ruleset requires`,
        ).toBe(false);
      }
    }
  });

  // The detectors above must fire on every shape that leaves a PR unreported,
  // or the gate regresses to a no-op that still reads green.
  test("pullRequestTriggerGaps: clean on every-PR shapes, fires on each filter", () => {
    expect(pullRequestTriggerGaps("pull_request")).toEqual([]);
    expect(pullRequestTriggerGaps(["push", "pull_request"])).toEqual([]);
    expect(pullRequestTriggerGaps({ pull_request: null })).toEqual([]);
    expect(
      pullRequestTriggerGaps({
        pull_request: { types: ["opened", "synchronize", "reopened"], branches: ["main"] },
      }),
    ).toEqual([]);
    expect(pullRequestTriggerGaps({ pull_request: { branches: ["**"] } })).toEqual([]);

    expect(pullRequestTriggerGaps({ push: { branches: ["main"] } })).toEqual([
      "no `pull_request` trigger",
    ]);
    expect(pullRequestTriggerGaps({ pull_request: { paths: ["src/**"] } })[0]).toContain("paths");
    expect(pullRequestTriggerGaps({ pull_request: { "paths-ignore": ["docs/**"] } })[0]).toContain(
      "paths-ignore",
    );
    expect(pullRequestTriggerGaps({ pull_request: { branches: ["release/*"] } })[0]).toContain(
      "does not match",
    );
    expect(pullRequestTriggerGaps({ pull_request: { branches: ["main", "!main"] } })[0]).toContain(
      "negation",
    );
    expect(pullRequestTriggerGaps({ pull_request: { "branches-ignore": ["ma*"] } })[0]).toContain(
      "branches-ignore",
    );
    expect(pullRequestTriggerGaps({ pull_request: { types: ["opened"] } })).toEqual([
      "`on.pull_request.types` omits `synchronize`",
      "`on.pull_request.types` omits `reopened`",
    ]);
  });

  test("publisherJobGaps: fires on `if:` and `continue-on-error` at either site", () => {
    expect(publisherJobGaps({ job: { "runs-on": "ubuntu-latest" }, reusableJob: null })).toEqual([]);
    expect(publisherJobGaps({ job: { "continue-on-error": false }, reusableJob: null })).toEqual([]);
    expect(publisherJobGaps({ job: { if: "always()" }, reusableJob: null })[0]).toContain("`if:`");
    expect(publisherJobGaps({ job: { uses: "x" }, reusableJob: { if: "false" } })[0]).toContain(
      "reusable job-level `if:`",
    );
    expect(publisherJobGaps({ job: { "continue-on-error": true }, reusableJob: null })[0]).toContain(
      "continue-on-error",
    );
    expect(
      publisherJobGaps({ job: { "continue-on-error": "${{ matrix.experimental }}" } })[0],
    ).toContain("continue-on-error");
  });

  // #527: a `needs:` + `if: always()` gate is the shape the cancellable lint
  // requires of a required-context publisher; anything looser still fires.
  test("publisherJobGaps: accepts a verbatim `always()` gate with `needs:`, nothing looser", () => {
    expect(publisherJobGaps({ job: { needs: "work", if: "${{ always() }}" } })).toEqual([]);
    expect(publisherJobGaps({ job: { needs: ["a", "b"], if: " always() " } })).toEqual([]);
    expect(
      publisherJobGaps({ job: { needs: "work", if: "always() && github.event_name == 'push'" } }),
    ).toHaveLength(1);
    expect(publisherJobGaps({ job: { needs: "work", if: "success()" } })).toHaveLength(1);
    expect(publisherJobGaps({ job: { if: "${{ always() }}" } })).toHaveLength(1);
    expect(publisherJobGaps({ job: { needs: "work", if: "!cancelled()" } })).toHaveLength(1);
  });
});
