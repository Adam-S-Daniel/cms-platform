// @lane: local — PURE-FS lint on the production deploy's admin cache headers
/*
 * The production admin shell must never be uploaded as cacheable.
 *
 * deploy-production.yml's "Sync to S3" step used to upload the whole site
 * with `public, max-age=86400`, admin included. For up to a day after a
 * release an editor's browser then ran the OLD admin page under the OLD
 * response-header CSP (#663). The admin scripts and styles are referenced by
 * unversioned URLs (`<script src="publish-button.js">`), so the whole
 * `admin/` prefix must revalidate, not only the HTML.
 *
 * The fix is two halves, and this lint holds both, in the same job:
 *   1. every max-age `aws s3 sync ./_site` excludes `admin/*`;
 *   2. a LATER step uploads `./_site/admin` with a Cache-Control naming
 *      `no-cache` or `no-store` (or max-age=0).
 * It also rejects any aws command whose source is under `./_site/admin` and
 * carries a long max-age.
 *
 * The workflow is parsed with the `yaml` parser (workflow-yaml-utils.js); the
 * shell inside each `run:` is then split into words with comment lines and
 * line continuations handled, so a comment that MENTIONS the flags cannot
 * satisfy (or trip) the lint.
 */
const { test, expect } = require("./base");
const {
  readWorkflow,
  parseYaml,
  awsCommands,
  flagValues,
  isLongCache,
  isUncacheable,
} = require("./workflow-yaml-utils");

const WORKFLOW = "deploy-production.yml";

const isSiteSync = (w) =>
  w[1] === "s3" && w[2] === "sync" && /^(\.\/)?_site\/?$/.test(w[3] || "");
const isAdminSource = (w) =>
  w[1] === "s3" &&
  (w[2] === "sync" || w[2] === "cp") &&
  /^(\.\/)?_site\/admin(\/|$)/.test(w[3] || "");
const excludesAdmin = (w) =>
  flagValues(w, "--exclude").some((v) => v === "admin/*" || v === "admin/**");

// Returns a list of problems (empty when the workflow is correct).
function audit(text) {
  const root = parseYaml(text) || {};
  const problems = [];
  let syncs = 0;
  for (const [jobName, job] of Object.entries(root.jobs || {})) {
    const steps = (job && job.steps) || [];
    steps.forEach((step, index) => {
      const label = `${jobName} / ${(step && step.name) || `step ${index}`}`;
      for (const words of awsCommands(step && step.run)) {
        const longCache = flagValues(words, "--cache-control").some(isLongCache);
        if (isAdminSource(words) && longCache) {
          problems.push(`${label}: uploads ./_site/admin with a max-age Cache-Control`);
        }
        if (!isSiteSync(words) || !longCache) continue;
        syncs += 1;
        if (!excludesAdmin(words)) {
          problems.push(`${label}: the max-age sync does not --exclude 'admin/*'`);
        }
        const later = steps.slice(index + 1).some((s) =>
          awsCommands(s && s.run).some(
            (w) =>
              isAdminSource(w) &&
              (w[2] === "sync" || w.includes("--recursive")) &&
              flagValues(w, "--cache-control").some(isUncacheable),
          ),
        );
        if (!later) {
          problems.push(
            `${label}: no later step in the job uploads ./_site/admin with a no-cache Cache-Control`,
          );
        }
      }
    });
  }
  if (syncs === 0) problems.push("no max-age `aws s3 sync ./_site` found — the lint lost its target");
  return problems;
}

test.describe("deploy-production: the admin shell is never cacheable", () => {
  test(`${WORKFLOW} excludes admin/* from the max-age sync and uploads it no-cache`, () => {
    expect(audit(readWorkflow(WORKFLOW))).toEqual([]);
  });

  test("the detector rejects the pre-fix shape and comment-only mentions", () => {
    const before = [
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Sync to S3",
      "        run: |",
      "          # --exclude 'admin/*' then aws s3 sync ./_site/admin --cache-control no-cache",
      '          aws s3 sync ./_site "s3://${PRODUCTION_BUCKET}/" \\',
      "            --delete \\",
      '            --cache-control "public, max-age=86400"',
    ].join("\n");
    expect(audit(before)).toHaveLength(2);
  });

  test("the detector accepts the fixed shape", () => {
    const after = [
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Sync to S3",
      "        run: |",
      '          aws s3 sync ./_site "s3://b/" --delete \\',
      '            --cache-control "public, max-age=86400" \\',
      "            --exclude 'admin/*'",
      "      - name: Upload admin",
      "        run: |",
      "          if [ -d ./_site/admin ]; then",
      '            aws s3 sync ./_site/admin "s3://b/admin/" --delete \\',
      '              --cache-control "no-cache, must-revalidate"',
      "          fi",
    ].join("\n");
    expect(audit(after)).toEqual([]);
  });

  test("the detector rejects an admin upload with a long max-age", () => {
    const bad = [
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Sync to S3",
      "        run: |",
      '          aws s3 sync ./_site "s3://b/" --delete \\',
      '            --cache-control "public, max-age=86400" \\',
      "            --exclude 'admin/*'",
      "      - name: Upload admin",
      "        run: |",
      '          aws s3 sync ./_site/admin "s3://b/admin/" --delete \\',
      '            --cache-control "public, max-age=86400"',
    ].join("\n");
    const problems = audit(bad);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("max-age");
  });
});
