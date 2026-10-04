// @lane: local — PURE-FS lint on the production deploy's 404 cache headers
/*
 * The production 404 page must never be uploaded as cacheable.
 *
 * CloudFront answers every missing key on the production distribution with
 * `/404.html` (CustomErrorResponses, ErrorCachingMinTTL 0) and passes that
 * object's own Cache-Control through. deploy-production.yml's "Sync to S3"
 * step uploads the whole site with `public, max-age=86400`, so before this
 * lint every 404 reached the browser as cacheable for a day. An editor's
 * draft upload 404s on the admin's origin until the post publishes, and the
 * cached 404 then kept the image broken in that editor's browser after the
 * file had arrived.
 *
 * The fix is two halves, and this lint holds both, in the same job:
 *   1. the max-age `aws s3 sync` of `./_site` excludes `404.html`;
 *   2. a LATER step copies `404.html` with a Cache-Control naming
 *      `no-cache` or `no-store` (or max-age=0).
 *
 * The workflow is parsed with the `yaml` parser (workflow-yaml-utils.js); the
 * shell inside each `run:` is then split into words with comment lines and
 * line continuations handled, so a comment that MENTIONS the flags cannot
 * satisfy (or trip) the lint.
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

const WORKFLOW = "deploy-production.yml";

// Shell words of every `aws ...` command in a run script: continuations are
// joined, full-line comments dropped, and quotes stripped from each word.
// Lexical by design — it reads shell tokens, not code structure.
function awsCommands(script) {
  const joined = String(script || "").replace(/\\\r?\n/g, " ");
  const out = [];
  for (const raw of joined.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const words = (line.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) =>
      w.replace(/^(["'])(.*)\1$/, "$2"),
    );
    const at = words.indexOf("aws");
    if (at !== -1) out.push(words.slice(at));
  }
  return out;
}

function flagValues(words, flag) {
  const values = [];
  words.forEach((w, i) => {
    if (w === flag && i + 1 < words.length) values.push(words[i + 1]);
    else if (w.startsWith(flag + "=")) values.push(w.slice(flag.length + 1));
  });
  return values;
}

function isLongCache(value) {
  const v = String(value).toLowerCase();
  const m = /max-age\s*=\s*(\d+)/.exec(v);
  return !/no-cache|no-store/.test(v) && Boolean(m) && Number(m[1]) > 0;
}

function isUncacheable(value) {
  const v = String(value).toLowerCase();
  return /no-cache|no-store/.test(v) || /(^|[\s,])max-age\s*=\s*0(\b|$)/.test(v);
}

// One finding per job holding the site's max-age sync. Returns a list of
// problems (empty when the workflow is correct).
function audit(text) {
  const root = parseYaml(text) || {};
  const problems = [];
  let syncs = 0;
  for (const [jobName, job] of Object.entries(root.jobs || {})) {
    const steps = (job && job.steps) || [];
    steps.forEach((step, index) => {
      for (const words of awsCommands(step && step.run)) {
        const isSiteSync =
          words[1] === "s3" && words[2] === "sync" && /^(\.\/)?_site\/?$/.test(words[3] || "");
        if (!isSiteSync) continue;
        if (!flagValues(words, "--cache-control").some(isLongCache)) continue;
        syncs += 1;
        const label = `${jobName} / ${step.name || `step ${index}`}`;
        if (!flagValues(words, "--exclude").includes("404.html")) {
          problems.push(`${label}: the max-age sync does not --exclude '404.html'`);
        }
        const later = steps.slice(index + 1).some((s) =>
          awsCommands(s && s.run).some(
            (w) =>
              w[1] === "s3" &&
              w[2] === "cp" &&
              /(^|\/)404\.html$/.test(w[3] || "") &&
              flagValues(w, "--cache-control").some(isUncacheable),
          ),
        );
        if (!later) {
          problems.push(
            `${label}: no later step in the job copies 404.html with a no-cache Cache-Control`,
          );
        }
      }
    });
  }
  if (syncs === 0) problems.push("no max-age `aws s3 sync ./_site` found — the lint lost its target");
  return problems;
}

test.describe("deploy-production: the 404 page is never cacheable", () => {
  test(`${WORKFLOW} excludes 404.html from the max-age sync and re-uploads it no-cache`, () => {
    expect(audit(readWorkflow(WORKFLOW))).toEqual([]);
  });

  test("the detector rejects the pre-fix shape and comment-only mentions", () => {
    const before = [
      "jobs:",
      "  deploy:",
      "    steps:",
      "      - name: Sync to S3",
      "        run: |",
      "          # --exclude '404.html' then aws s3 cp ./_site/404.html --cache-control no-cache",
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
      "            --exclude '404.html'",
      "      - name: Upload 404",
      "        run: |",
      "          if [ -f ./_site/404.html ]; then",
      '            aws s3 cp ./_site/404.html "s3://b/404.html" \\',
      '              --cache-control "no-cache, must-revalidate"',
      "          fi",
    ].join("\n");
    expect(audit(after)).toEqual([]);
  });
});
