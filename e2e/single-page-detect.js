#!/usr/bin/env node
// @lane: local — CLI + pure decision, no browser, no network
/*
 * "Is the site this loop runs against a single-page bio?" for the daily real
 * publish loops (#1068).
 *
 * `cms-publish-loop-prod`, `cms-scheduled-publish-loop` and `cms-media-roundtrip`
 * publish through the `posts` collection. A site with `cms.base_collections: []`
 * (jodidaniel.com) has none, so since `summarize-playwright.js --require-ran`
 * made a loop that ran nothing fail, those three would go red every day there.
 * The host loop covers a single-page site with its own collections
 * (`cms-publish-loop-single-page.spec.js`), so these three skip their heavy
 * steps on one, naming the site, and the job still reports success.
 *
 * The answer is `isSinglePageConsumer` from site-capabilities.js, which parses
 * the site's `_config.yml` with a real YAML parser. This file only turns it
 * into a step output and a notice.
 *
 * Usage (from a workflow step, working-directory .cms-platform/e2e):
 *   SITE_ROOT=<site checkout> GITHUB_REPOSITORY=<owner/repo> node single-page-detect.js
 * Appends `single_page=true|false` to $GITHUB_OUTPUT and prints the notice.
 * Always exits 0: it decides nothing but what to skip.
 */
const fs = require("node:fs");
const { isSinglePageConsumer } = require("./site-capabilities");

// The `::notice::` annotation for a skipped loop. `repo` is `owner/name`, a
// public identifier; nothing else about the site is printed.
function skipNotice(repo, loopName) {
  const site = repo || "this site";
  return (
    `::notice title=Single-page site::${site} is a single-page site ` +
    `(cms.base_collections: []) with no posts collection, so the ${loopName} loop ` +
    "skips its publish steps here. The host loop (cms-publish-loop-host) covers it " +
    "with cms-publish-loop-single-page.spec.js."
  );
}

// { singlePage, notice } for a site root. `notice` is "" when the loop runs.
function detect({ siteRoot, repo, loopName }) {
  const singlePage = isSinglePageConsumer(siteRoot);
  return { singlePage, notice: singlePage ? skipNotice(repo, loopName) : "" };
}

function main(env = process.env, out = process.stdout) {
  const siteRoot = env.SITE_ROOT;
  if (!siteRoot) {
    // Fail OPEN: no site root means we cannot tell, so the loop runs as before.
    out.write("::warning::SITE_ROOT is not set; treating the site as a full site.\n");
    return { singlePage: false, line: "single_page=false" };
  }
  const { singlePage, notice } = detect({
    siteRoot,
    repo: env.GITHUB_REPOSITORY || "",
    loopName: env.LOOP_NAME || "publish",
  });
  if (notice) out.write(`${notice}\n`);
  const line = `single_page=${singlePage ? "true" : "false"}`;
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${line}\n`);
  return { singlePage, line };
}

if (require.main === module) {
  main();
}

module.exports = { skipNotice, detect, main };
