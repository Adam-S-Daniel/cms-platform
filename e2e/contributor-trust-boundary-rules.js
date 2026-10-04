"use strict";
/*
 * contributor-trust-boundary-rules — the detector behind the contributor
 * trust-boundary lint (#536), in ONE place so the platform lint
 * (contributor-trust-boundary-lint.test.js) and its CONSUMER-mode sibling
 * (consumer-contributor-trust-boundary-lint.test.js) cannot drift apart.
 *
 * ── THE BOUNDARY ──────────────────────────────────────────────────────────
 * A preview at `https://preview-*.<apex>` is a trusted sign-in origin (#520,
 * #535): its JavaScript receives the editor's OAuth token, whose scopes reach
 * repository AND workflow writes. So whoever can get code onto a preview can
 * act as the editor. Today that is only someone who can push a branch to the
 * site repo, because the preview is built and deployed by a `pull_request`
 * run, and GitHub gives a `pull_request` run from a FORK a read-only token, no
 * repository secrets and no OIDC token: the fork's code runs, but it cannot
 * assume the AWS role that deploys a preview. An outside contributor's run
 * additionally waits for a maintainer's approval (`approval_policy:
 * all_external_contributors`, repo-settings.yml).
 *
 * What breaks that is any trigger that runs in the BASE repo's context, with
 * its secrets and a write-capable token, yet can be fired by someone the repo
 * never trusted: `pull_request_target` and `workflow_run` (a fork's PR fires
 * both), and `issue_comment`, `issues`, `discussion`, `discussion_comment`,
 * `fork` and `watch` (any GitHub user fires those on a public repo). See
 * PRIVILEGED below for each. Checking out the PR's code there (a `refs/pull/`
 * ref built from an issue number, say) or ingesting the triggering run's
 * artifacts hands attacker code the secrets — the "pwn request".
 * docs/ADMIN-AUTH-SECURITY.md, "Outside contributors and previews", is the
 * long form.
 *
 * ── THE RULES ─────────────────────────────────────────────────────────────
 *   no-pull-request-target      no workflow declares `pull_request_target`.
 *   permissions-declared        a workflow a contributor can reach declares a
 *                               top-level `permissions:` map, and nothing in
 *                               any workflow is `write-all`.
 *   privileged-read-only-token  under a privileged trigger, no GITHUB_TOKEN
 *                               scope is `write` (writes go through a named
 *                               secret the job was deliberately given).
 *   no-secrets-inherit          a job a contributor can reach never passes
 *                               `secrets: inherit`; it names each secret.
 *   privileged-no-head-ref      under a privileged trigger, no checkout `ref:`
 *                               / `repository:` and no reusable-call `with:`
 *                               value references the PR or triggering run's
 *                               HEAD (branch, sha, repo, merge commit), and no
 *                               checkout names a `refs/pull/` ref.
 *   privileged-no-run-artifacts under a privileged trigger, no step downloads
 *                               artifacts: no `actions/download-artifact`, and
 *                               no github-script body (read with ACORN) naming
 *                               an artifact REST method, requesting an
 *                               `/artifacts` route, or calling through a
 *                               computed member it cannot resolve. A body
 *                               acorn cannot parse is denied.
 *   head-checkout-by-sha        a checkout of the PR head pins the immutable
 *                               `github.event.pull_request.head.sha`, never a
 *                               branch name, which resolves at checkout time
 *                               to whatever was pushed after an approval.
 *
 * "Privileged" is judged on a workflow's EFFECTIVE events: a reusable
 * (`workflow_call`) runs under whatever its callers were triggered by, so its
 * effective events are the union of its callers' (`effectiveEvents`). That is
 * what lets the platform lint check the reusables consumers call, through the
 * canonical thin callers under examples/site/.
 *
 * Expression references are read with the hardened lexer shared with the
 * injection lint (gha-expression-lexer.js), so `github['head_ref']` and
 * `GitHub.Event.Pull_Request.Head.Ref` are the same path, and a span the lexer
 * cannot read is DENIED, never resolved to safe. `${{ github.event.* }}` in a
 * `run:` body is NOT re-checked here: workflow-injection-lint.test.js owns it.
 *
 * ── WHAT IT CANNOT SEE ────────────────────────────────────────────────────
 * Shell: a `run:` body doing `git fetch origin pull/N/head` or
 * `gh run download` under a privileged trigger is invisible (shell is not
 * parsed). Local composite actions referenced as
 * `uses: ./.github/actions/...` are not expanded here, so a wrapped artifact
 * download is invisible. Dataflow: a head ref laundered through a step output
 * or an `env:` value before reaching `ref:` is invisible. These gaps are why
 * `no-pull-request-target` is a ban rather than a pattern check.
 */
const YAML = require("yaml");
const acorn = require("acorn");
const walk = require("acorn-walk");
const { ANY, interpolations, contextPaths } = require("./gha-expression-lexer");

// PRIVILEGED: runs in the base repo's context with its secrets and a token
// that can write, and an untrusted party can fire it.
//   pull_request_target  a fork's PR, with the base workflow file.
//   workflow_run         fires after a run a fork's PR caused.
//   issue_comment        any user commenting on an issue or PR (the classic
//                        "/deploy" ChatOps pwn: refs/pull/<issue.number>/head).
//   issues               any user opening or editing an issue.
//   discussion,          any user, where Discussions are enabled.
//   discussion_comment
//   fork, watch          any user forking or starring. No code or text to
//                        abuse, but the run still holds secrets and a write
//                        token on an attacker's schedule.
// EXCLUDED, deliberately:
//   pull_request_review, pull_request_review_comment  for a fork's PR GitHub
//                        restricts these exactly like `pull_request` (read-only
//                        token, no secrets), so they are contributor-REACHABLE
//                        but not privileged.
//   push, schedule, workflow_dispatch, repository_dispatch, release, create,
//   delete, deployment*, status, check_*  need write access (or the repo's own
//                        schedule) to fire, which is already trust.
//   merge_group          only for PRs a writer queued.
const PRIVILEGED = [
  "pull_request_target",
  "workflow_run",
  "issue_comment",
  "issues",
  "discussion",
  "discussion_comment",
  "fork",
  "watch",
];
// Triggers an outside contributor can cause, privileged or not.
const CONTRIBUTOR_REACHABLE = [
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  ...PRIVILEGED,
];

// Context paths whose value is chosen by whoever pushed the PR or the run
// that triggered a `workflow_run`. Folded segments; ANY matches any name.
const HEAD_ROOTS = [
  ["github", "head_ref"],
  ["github", "event", "pull_request", "head"],
  ["github", "event", "pull_request", "merge_commit_sha"],
  ["github", "event", "workflow_run", "head_branch"],
  ["github", "event", "workflow_run", "head_sha"],
  ["github", "event", "workflow_run", "head_commit"],
  ["github", "event", "workflow_run", "head_repository"],
  ["github", "event", "workflow_run", "pull_requests", ANY, "head"],
];
const PR_HEAD_SHA = ["github", "event", "pull_request", "head", "sha"];

// The REST methods that list or fetch workflow-run artifacts.
const ARTIFACT_METHODS = new Set([
  "listworkflowrunartifacts",
  "listartifactsforrepo",
  "getartifact",
  "downloadartifact",
]);

// Action refs are matched case-insensitively: GitHub resolves
// `Actions/Checkout@…` to the same action. Any action whose name carries
// `download-artifact` counts (`dawidd6/action-download-artifact` is the common
// third-party one that reads ANOTHER run's artifacts).
const CHECKOUT = /^actions\/checkout@/i;
const DOWNLOAD_ARTIFACT = /^[^@]*download-artifact[^@]*@/i;
const GITHUB_SCRIPT = /^actions\/github-script@/i;

// A descendant of a root (`…head.ref`) counts, and so does an ancestor down
// to the payload object (`github`, `github.event`, `github.event.workflow_run`),
// which `toJSON()` serializes whole. A DEEPER ancestor does not count: the
// canonical workflow_run caller guards with
// `github.event.workflow_run.pull_requests[0] && …pull_requests[0].number`,
// where the element is only a truthiness test. The cost is that
// `toJSON(github.event.workflow_run.pull_requests[0])` is not seen.
const ANCESTOR_DEPTH = 3;
function onBranch(pathSegs, root) {
  if (pathSegs.length < root.length && pathSegs.length > ANCESTOR_DEPTH) return false;
  const shared = Math.min(pathSegs.length, root.length);
  for (let i = 0; i < shared; i += 1) {
    if (pathSegs[i] !== root[i] && pathSegs[i] !== ANY && root[i] !== ANY) return false;
  }
  return true;
}

// Head-data references in one scalar value: [{ path, unreadable }].
function headRefs(value) {
  const out = [];
  if (typeof value !== "string") return out;
  for (const occ of interpolations(value)) {
    if (occ.unreadable) {
      out.push({ path: null, text: occ.text, unreadable: true });
      continue;
    }
    for (const p of contextPaths(occ.text)) {
      if (HEAD_ROOTS.some((r) => onBranch(p, r))) out.push({ path: p, text: occ.text, unreadable: false });
    }
  }
  return out;
}

const samePath = (a, b) => a.length === b.length && a.every((s, i) => s === b[i]);

function events(onValue) {
  if (onValue == null) return [];
  if (typeof onValue === "string") return [onValue];
  if (Array.isArray(onValue)) return onValue.map(String);
  return Object.keys(onValue);
}

// `yaml` parses a bare `on:` key as the string "on" (YAML 1.2), but guard
// against a 1.1 boolean key anyway.
function onOf(wf) {
  return wf.on !== undefined ? wf.on : wf[true];
}

// `<owner>/<repo>/.github/workflows/<file>@<ref>` or `./.github/workflows/<file>`
// → the reusable's basename when it lives in `platformRepo` (or locally).
function reusableName(uses, platformRepo) {
  if (typeof uses !== "string") return null;
  const local = "./.github/workflows/";
  if (uses.startsWith(local)) return uses.slice(local.length);
  const at = uses.indexOf("@");
  const target = at < 0 ? uses : uses.slice(0, at);
  const prefix = `${platformRepo}/.github/workflows/`;
  if (platformRepo && target.toLowerCase().startsWith(prefix.toLowerCase())) return target.slice(prefix.length);
  return null;
}

// Parse every file once: [{ file, name, origin, wf, own }].
function load(files) {
  return files.map((f) => {
    const wf = YAML.parse(f.text, { merge: true }) || {};
    return { ...f, wf, own: events(onOf(wf)) };
  });
}

// Effective events per PLATFORM workflow (by basename): its own events, with
// `workflow_call` replaced by the union of its callers' effective events.
// Callers are every loaded workflow (platform, template or consumer) whose
// job `uses:` resolves to it. Fixpoint, so a reusable calling a reusable
// inherits transitively.
function effectiveEvents(loaded, platformRepo) {
  const eff = new Map();
  for (const w of loaded) eff.set(w, new Set(w.own.filter((e) => e !== "workflow_call")));
  const byName = new Map(loaded.filter((w) => w.origin === "platform").map((w) => [w.name, w]));
  const edges = [];
  for (const w of loaded) {
    for (const job of Object.values((w.wf && w.wf.jobs) || {})) {
      const target = byName.get(reusableName(job && job.uses, platformRepo));
      if (target && target.own.includes("workflow_call")) edges.push([w, target]);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, to] of edges) {
      for (const e of eff.get(from)) {
        if (!eff.get(to).has(e)) {
          eff.get(to).add(e);
          changed = true;
        }
      }
    }
  }
  const callers = new Map();
  for (const [from, to] of edges) {
    if (!callers.has(to)) callers.set(to, []);
    callers.get(to).push(from);
  }
  return { eff, callers };
}

// What a github-script body touches, read with acorn: every STATIC member
// name and every destructured key (`const { downloadArtifact } =
// github.rest.actions`), folded; ANY for a call through a computed member
// (`api[name]()`) or a computed destructuring key; and "route:artifacts" for a
// `request()` whose route names the artifacts endpoint OR is not a plain
// literal (a variable, an object, a template with `${}`): a route the parser
// cannot read is denied. A name inside a comment or a string literal is not a
// member and is not seen. Throws on a body acorn cannot parse.
function scriptProperties(body) {
  const ast = acorn.parse(body, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  });
  const names = [];
  const staticName = (node) => {
    const p = node.property;
    if (!node.computed && p.type === "Identifier") return p.name.toLowerCase();
    if (p.type === "Literal" && typeof p.value === "string") return p.value.toLowerCase();
    return null;
  };
  walk.full(ast, (node) => {
    if (node.type === "MemberExpression") {
      const n = staticName(node);
      if (n !== null) names.push(n);
    } else if (node.type === "ObjectPattern") {
      for (const prop of node.properties) {
        if (prop.type !== "Property") continue;
        if (!prop.computed && prop.key.type === "Identifier") names.push(prop.key.name.toLowerCase());
        else if (prop.key.type === "Literal" && typeof prop.key.value === "string") names.push(prop.key.value.toLowerCase());
        else names.push(ANY);
      }
    } else if (node.type === "CallExpression") {
      let n = null;
      if (node.callee.type === "MemberExpression") {
        n = staticName(node.callee);
        if (n === null) names.push(ANY);
      } else if (node.callee.type === "Identifier") {
        n = node.callee.name.toLowerCase();
      }
      if (n === "request") {
        const a = node.arguments[0];
        let text = null;
        if (a && a.type === "Literal" && typeof a.value === "string") text = a.value;
        else if (a && a.type === "TemplateLiteral" && a.expressions.length === 0) text = a.quasis[0].value.cooked;
        if (text === null || text.includes("/artifacts")) names.push("route:artifacts");
      }
    }
  });
  return names;
}

const fmtPath = (p) => (p ? p.map((s) => (s === ANY ? "*" : s)).join(".") : "(unreadable)");

/**
 * Lint a set of workflow files. `files`: [{ file, name, text, origin }], where
 * `origin` is "platform" (this repo's .github/workflows), "template"
 * (examples/site) or "consumer". `platformRepo` resolves cross-repo reusable
 * calls back to platform files; omit it in consumer mode.
 * Returns { offences: [{ rule, file, where, detail }], effective, callers }.
 */
function lintWorkflows(files, { platformRepo = null } = {}) {
  const loaded = load(files);
  const { eff, callers } = effectiveEvents(loaded, platformRepo);
  const offences = [];
  const add = (rule, w, where, detail) => offences.push({ rule, file: w.file, where, detail });

  for (const w of loaded) {
    const ev = eff.get(w);
    const privileged = PRIVILEGED.filter((e) => ev.has(e));
    const reachable = CONTRIBUTOR_REACHABLE.some((e) => ev.has(e));
    const jobs = (w.wf && w.wf.jobs) || {};

    if (w.own.includes("pull_request_target")) {
      add("no-pull-request-target", w, "on", "`pull_request_target` runs with the base repo's secrets and a write token for fork PRs");
    }

    const perms = w.wf.permissions;
    if (reachable && (perms === undefined || perms === null || typeof perms !== "object")) {
      if (perms !== "read-all") {
        add("permissions-declared", w, "permissions", `a contributor-reachable workflow needs a top-level permissions map (found ${JSON.stringify(perms)})`);
      }
    }
    const scopes = [["(top level)", perms], ...Object.entries(jobs).map(([jn, j]) => [`job ${jn}`, j && j.permissions])];
    for (const [where, p] of scopes) {
      if (p === "write-all") add("permissions-declared", w, where, "`write-all` grants every scope");
      if (privileged.length && p && typeof p === "object") {
        for (const [scope, level] of Object.entries(p)) {
          if (level === "write") {
            add("privileged-read-only-token", w, `${where} permissions.${scope}`, `\`${scope}: write\` under ${privileged.join(", ")}`);
          }
        }
      }
    }

    for (const [jn, job] of Object.entries(jobs)) {
      if (!job || typeof job !== "object") continue;
      if (reachable && job.secrets === "inherit") {
        add("no-secrets-inherit", w, `job ${jn}`, "`secrets: inherit` hands every repository secret to the called workflow");
      }
      if (privileged.length && job.uses && job.with && typeof job.with === "object") {
        for (const [k, v] of Object.entries(job.with)) {
          for (const h of headRefs(v)) {
            add("privileged-no-head-ref", w, `job ${jn} with.${k}`, `passes ${h.unreadable ? `an unreadable expression ${h.text}` : fmtPath(h.path)} to a reusable under ${privileged.join(", ")}`);
          }
        }
      }
      const steps = Array.isArray(job.steps) ? job.steps : [];
      steps.forEach((step, i) => {
        if (!step || typeof step !== "object") return;
        const uses = typeof step.uses === "string" ? step.uses : "";
        const where = `job ${jn} step ${step.name ? JSON.stringify(step.name) : `#${i + 1}`}`;
        const withMap = step.with && typeof step.with === "object" ? step.with : {};
        if (CHECKOUT.test(uses)) {
          for (const key of ["ref", "repository"]) {
            const v = withMap[key];
            const refs = headRefs(v);
            if (privileged.length) {
              for (const h of refs) {
                add("privileged-no-head-ref", w, `${where} with.${key}`, `checks out ${h.unreadable ? `an unreadable expression ${h.text}` : fmtPath(h.path)} under ${privileged.join(", ")}`);
              }
              if (typeof v === "string" && v.includes("refs/pull/")) {
                add("privileged-no-head-ref", w, `${where} with.${key}`, `checks out a refs/pull/ ref under ${privileged.join(", ")}`);
              }
            }
            if (key === "ref") {
              for (const h of refs) {
                if (h.unreadable || !samePath(h.path, PR_HEAD_SHA)) {
                  add("head-checkout-by-sha", w, `${where} with.ref`, `checks out ${h.unreadable ? `an unreadable expression ${h.text}` : fmtPath(h.path)}; pin github.event.pull_request.head.sha`);
                }
              }
            }
          }
        }
        if (privileged.length && DOWNLOAD_ARTIFACT.test(uses)) {
          add("privileged-no-run-artifacts", w, where, `downloads artifacts under ${privileged.join(", ")}`);
        }
        if (privileged.length && GITHUB_SCRIPT.test(uses) && typeof withMap.script === "string") {
          let props;
          try {
            props = scriptProperties(withMap.script);
          } catch (e) {
            add("privileged-no-run-artifacts", w, `${where} with.script`, `github-script body does not parse (${e.message}); an unreadable body is denied`);
            return;
          }
          const hit = props.find((n) => n === ANY || n === "route:artifacts" || ARTIFACT_METHODS.has(n));
          if (hit !== undefined) {
            add("privileged-no-run-artifacts", w, `${where} with.script`, `github-script ${hit === ANY ? "uses a computed member (unresolvable)" : `${hit === "route:artifacts" ? "requests an artifacts route, or a route it cannot read" : `calls the artifact API (${hit})`}`} under ${privileged.join(", ")}`);
          }
        }
      });
    }
  }
  return { offences, effective: eff, callers, loaded };
}

const formatOffence = (o) => `${o.file}: [${o.rule}] ${o.where}: ${o.detail}`;

module.exports = {
  PRIVILEGED,
  CONTRIBUTOR_REACHABLE,
  HEAD_ROOTS,
  headRefs,
  reusableName,
  lintWorkflows,
  formatOffence,
};
