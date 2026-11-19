// @lane: local — pure-fs lint of a composite action; no browser, no network
/*
 * Regression test: the await-prod-deploy composite reads prod's
 * `<apex>/admin/commit.json` as ground truth that CloudFront serves the merge.
 * Once a site moves its editor to its own admin host (`cms.admin_origin`),
 * `<apex>/admin/*` answers 302 to that host. A curl that does not follow the
 * redirect reads an empty body, reports `<unreachable>` for the full 600s
 * window and fails the Cross-post run even though the deploy succeeded
 * (adamdaniel.ai run 44557601632, 2026-11-19: post live, run red, so the
 * Mastodon/LinkedIn legs were skipped).
 *
 * The steps are read from the parsed YAML; only the `curl` word inside the
 * `run:` body is matched lexically, and comment lines are skipped.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

const ACTION = path.resolve(
  __dirname,
  "..",
  ".github",
  "actions",
  "await-prod-deploy",
  "action.yml",
);

// Every `curl` invocation (with its backslash-continued lines) that targets
// "$AD_COMMIT_URL", from a `run:` body.
function commitUrlCurls(script) {
  const joined = script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n")
    .replace(/\\\n/g, " ");
  return joined.split("\n").filter((l) => /\bcurl\b/.test(l) && /\$AD_COMMIT_URL/.test(l));
}

function followsRedirects(curlLine) {
  return /\s(-[A-Za-z]*L[A-Za-z]*|--location)\s/.test(curlLine);
}

test("the detector flags a curl that does not follow redirects", () => {
  expect(followsRedirects('live="$(curl -fsS --max-time 15 "$AD_COMMIT_URL")"')).toBe(false);
  expect(followsRedirects('live="$(curl -fsSL --max-time 15 "$AD_COMMIT_URL")"')).toBe(true);
  expect(followsRedirects('live="$(curl --location -fsS "$AD_COMMIT_URL")"')).toBe(true);
});

test("await-prod-deploy follows redirects when it reads the prod commit.json", () => {
  const action = parseYaml(fs.readFileSync(ACTION, "utf8"));
  const scripts = action.runs.steps.map((s) => s.run).filter(Boolean);
  const curls = scripts.flatMap(commitUrlCurls);
  expect(curls.length, "a curl against $AD_COMMIT_URL").toBeGreaterThan(0);
  for (const c of curls) {
    expect(followsRedirects(c), `curl must follow redirects: ${c.trim()}`).toBe(true);
  }
});
