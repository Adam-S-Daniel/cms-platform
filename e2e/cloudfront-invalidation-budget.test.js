// @lane: local — pure-Node: parses the platform's workflow, composite-action and
// bootstrap-template YAML with the real `yaml` package; no network.
//
// 2026-10 incident: the AWS account's free tier covers 1,000 CloudFront
// invalidation PATHS a month (a `/*` wildcard counts as one), and October hit
// 100% (alert dated 2026-10-19). Preview deploys, preview teardowns and
// visual-regression runs were invalidating the preview distribution, which uses
// CachingDisabled and so never stores a response: every one of those paths was
// wasted. Only deploy-production invalidates now, with one `/*` per deploy.
// This lint keeps it that way. See docs/OPERATIONS.md § CloudFront invalidation
// budget.
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { test, expect } = require("./base");

const ROOT = path.join(__dirname, "..");
const SCAN_DIRS = [
  ".github/workflows",
  ".github/actions",
  "examples/site/.github/workflows",
];
const TEMPLATE_PATH = path.join(ROOT, "infrastructure", "bootstrap", "template.yaml");
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

// Every .yml/.yaml file under dir, as repo-relative POSIX paths, sorted.
function yamlFiles(dir) {
  const out = [];
  const walk = (abs) => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(entry.name)) {
        out.push(path.relative(ROOT, p).split(path.sep).join("/"));
      }
    }
  };
  if (fs.existsSync(path.join(ROOT, dir))) walk(path.join(ROOT, dir));
  return out.sort();
}

// Parse with merge keys resolved; short-form CloudFormation tags (!Sub, !Ref)
// are irrelevant to the scalar fields read here, so warnings are silenced.
function parse(rel) {
  return YAML.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"), {
    merge: true,
    logLevel: "silent",
  });
}

// [{ file, job, name, step }] for every step of a workflow (jobs.*.steps) or a
// composite action (runs.steps).
function stepsOf(rel, doc) {
  const out = [];
  const add = (job, steps) => {
    for (const step of Array.isArray(steps) ? steps : []) {
      out.push({ file: rel, job, name: step && step.name, step });
    }
  };
  for (const [job, def] of Object.entries((doc && doc.jobs) || {})) add(job, def && def.steps);
  if (doc && doc.runs) add("(composite action)", doc.runs.steps);
  return out;
}

function invalidatingSteps() {
  return SCAN_DIRS.flatMap(yamlFiles)
    .flatMap((rel) => stepsOf(rel, parse(rel)))
    .filter(({ step }) => typeof step.run === "string" && step.run.includes("create-invalidation"));
}

test.describe("CloudFront invalidation budget", () => {
  test("only deploy-production invalidates, and only once per deploy", () => {
    const found = invalidatingSteps().map(({ file, job, name }) => ({ file, job, name }));
    expect(
      found,
      "the free tier is 1,000 invalidation paths per month per AWS account; a new " +
        "`create-invalidation` step must be budgeted first (docs/OPERATIONS.md § CloudFront invalidation budget)",
    ).toEqual([
      {
        file: ".github/workflows/deploy-production.yml",
        job: "deploy",
        name: "Invalidate CloudFront cache",
      },
    ]);
  });

  test("the production invalidation is a single `/*` path gated on the distribution id", () => {
    const [{ step }] = invalidatingSteps();
    const doc = parse(".github/workflows/deploy-production.yml");

    const paths = step.run.match(/--paths((?:\s+(?:"[^"]*"|'[^']*'|[^\s\\]+))+)/);
    expect(paths, "the invalidation must pass --paths").toBeTruthy();
    expect(
      paths[1].trim(),
      "exactly one wildcard path: each extra path spends the monthly budget",
    ).toBe('"/*"');

    expect(String(step.if || ""), "the step must skip when no distribution id is set").toMatch(
      /env\.CLOUDFRONT_DISTRIBUTION_ID\s*!=\s*''/,
    );
    expect(
      doc.jobs.deploy.env.CLOUDFRONT_DISTRIBUTION_ID,
      "the production job maps its distribution id from PRODUCTION_CLOUDFRONT_ID",
    ).toBe("${{ secrets.PRODUCTION_CLOUDFRONT_ID }}");
  });

  test("preview and admin distributions are CachingDisabled, so they need no invalidation", () => {
    const template = parse(path.relative(ROOT, TEMPLATE_PATH));
    const behaviors = [];
    for (const name of ["PreviewDistribution", "AdminDistribution"]) {
      const config = template.Resources[name].Properties.DistributionConfig;
      behaviors.push({
        where: `${name} DefaultCacheBehavior`,
        id: config.DefaultCacheBehavior.CachePolicyId,
      });
      (config.CacheBehaviors || []).forEach((b, i) =>
        behaviors.push({
          where: `${name} CacheBehaviors[${i}] (${b.PathPattern})`,
          id: b.CachePolicyId,
        }),
      );
    }
    // PreviewDistribution has a default plus /admin/* and /regression.json.
    expect(behaviors.length, "expected the preview and admin behaviors to be found").toBeGreaterThanOrEqual(4);
    for (const { where, id } of behaviors) {
      expect(
        id,
        `${where} must use CachingDisabled (${CACHING_DISABLED}). That is the precondition ` +
          "that makes skipping preview/admin invalidation correct: if you make it cacheable, " +
          "you must add an invalidation and re-budget the monthly 1,000 free paths first.",
      ).toBe(CACHING_DISABLED);
    }
  });
});
