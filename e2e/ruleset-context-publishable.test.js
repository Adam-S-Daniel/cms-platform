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
const { parseYaml } = require("./workflow-yaml-utils");

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

// Contexts the platform repo's own PRs can carry. A `workflow_call`-only
// workflow is a reusable: it never runs on this repo's PRs, so it publishes no
// context here (AGENTS.md, "most workflows are workflow_call-only reusables").
function platformContexts() {
  const out = new Map();
  for (const { file, doc } of readWorkflowDir(PLATFORM_WORKFLOWS)) {
    const on = doc.on !== undefined ? doc.on : doc.true; // YAML 1.1 reads bare `on:` as true
    const triggers = on && typeof on === "object" ? Object.keys(on) : on ? [String(on)] : [];
    if (triggers.length === 1 && triggers[0] === "workflow_call") continue;
    for (const [id, job] of Object.entries(jobsOf(doc))) out.set(jobLabel(id, job), file);
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
