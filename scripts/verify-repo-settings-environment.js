#!/usr/bin/env node
/*
 * Verify that a repo-settings-apply environment is really configured the way
 * the workflow assumes, and refuse to continue if it is not (#870).
 *
 * WHY THIS EXISTS: naming an environment in a job's `environment:` does NOT
 * fail when that environment is missing or unprotected. GitHub implicitly
 * creates it with NO protection rules, so both controls this workflow relies
 * on can disappear without a single red run:
 *
 *   - the `repo-settings` REVIEWER gate (header note 3 of
 *     .github/workflows/repo-settings-apply.yml), and
 *   - the `main`-only deployment-branch policy on BOTH environments (header
 *     note 7). That policy is what keeps REPO_SETTINGS_APP_PRIVATE_KEY, an
 *     environment secret, away from a workflow run on any other branch. Without
 *     it, a PR branch that edits the workflow can read the App key.
 *
 * So each job that reads the key first asks the API what its environment
 * really is. This is the ONE implementation of that check; it replaced the
 * inline `case` guard the gated lane used to carry.
 *
 * What "correct" means:
 *   - the environment exists;
 *   - `deployment_branch_policy` is CUSTOM branch policies
 *     (`custom_branch_policies: true`, `protected_branches: false`);
 *   - exactly ONE policy, of type `branch`, named `main`. A second policy, a
 *     pattern, or a `tag` policy each widens who can read the secret;
 *   - with --require-reviewers, a `required_reviewers` protection rule.
 *
 * Usage (GH_TOKEN in the environment; `github.token` with contents:read is
 * enough on this public repo):
 *   node scripts/verify-repo-settings-environment.js --repo OWNER/REPO \
 *     --environment NAME [--require-reviewers]
 *
 * Exits 0 when the environment matches, 1 otherwise. It never prints an API
 * response body: errors carry the endpoint and the HTTP status only.
 */
const { execFileSync } = require("node:child_process");

const REQUIRED_BRANCH = "main";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// Pure: every reason `env` + `policies` (the two GET bodies) fall short.
// An empty list means the environment is configured as required.
// `env === null` means the environment GET answered 404.
function checkEnvironment({ name, env, policies, requireReviewers = false }) {
  if (!env) {
    return [
      `environment \`${name}\` does not exist. Referencing it from a job would ` +
        "silently create it with no protection rules.",
    ];
  }
  const problems = [];
  const dbp = env.deployment_branch_policy;
  if (!dbp || dbp.custom_branch_policies !== true || dbp.protected_branches !== false) {
    problems.push(
      `environment \`${name}\` does not restrict deployments to custom branch policies ` +
        `(deployment_branch_policy=${JSON.stringify(dbp ?? null)}), so a run on any branch can read its secrets.`,
    );
  }
  const list = policies && Array.isArray(policies.branch_policies) ? policies.branch_policies : [];
  const total = policies && Number.isInteger(policies.total_count) ? policies.total_count : list.length;
  const described = list.map((p) => `${p.type || "?"}:${p.name}`).join(", ") || "<none>";
  if (
    total !== 1 ||
    list.length !== 1 ||
    list[0].name !== REQUIRED_BRANCH ||
    list[0].type !== "branch"
  ) {
    problems.push(
      `environment \`${name}\` must allow exactly one deployment branch policy, ` +
        `branch:${REQUIRED_BRANCH}; found ${total} (${described}).`,
    );
  }
  if (requireReviewers) {
    const types = (env.protection_rules || []).map((r) => r && r.type);
    if (!types.includes("required_reviewers")) {
      problems.push(
        `environment \`${name}\` has no required_reviewers rule, so this apply would run UNATTENDED.`,
      );
    }
  }
  return problems;
}

// GET, returning parsed JSON, or null on 404. Any other failure throws with
// the status only, never the body (it is a public Actions log).
function ghGet(endpoint) {
  try {
    return JSON.parse(
      execFileSync("gh", ["api", endpoint], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (e) {
    const status = /HTTP (\d{3})/.exec(`${(e && e.stderr) || ""}`);
    if (status && status[1] === "404") return null;
    throw new Error(`gh api GET ${endpoint} failed` + (status ? ` (HTTP ${status[1]})` : ""));
  }
}

function main() {
  const repo = arg("repo");
  const name = arg("environment");
  const requireReviewers = process.argv.includes("--require-reviewers");
  if (!repo || !name) {
    console.error(
      "usage: verify-repo-settings-environment.js --repo OWNER/REPO --environment NAME [--require-reviewers]",
    );
    return 1;
  }
  const base = `repos/${repo}/environments/${encodeURIComponent(name)}`;
  const env = ghGet(base);
  const policies = env ? ghGet(`${base}/deployment-branch-policies?per_page=100`) : null;
  const problems = checkEnvironment({ name, env, policies, requireReviewers });
  if (problems.length) {
    for (const p of problems) console.log(`::error::${p}`);
    console.log(
      `::error::Refusing to continue: fix the \`${name}\` environment in Settings > Environments, then re-run.`,
    );
    return 1;
  }
  console.log(
    `::notice::environment \`${name}\` verified: deployments limited to branch:${REQUIRED_BRANCH}` +
      (requireReviewers ? ", required reviewer present." : "."),
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`::error::verify-repo-settings-environment: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { REQUIRED_BRANCH, checkEnvironment };
