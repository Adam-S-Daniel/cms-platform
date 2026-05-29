// @lane: local — pure-fs lint of the deploy-preview workflow YAML
/*
 * Regression test for the deploy-preview bot's sticky comment.
 *
 * Both the deploy and teardown paths must reuse the SAME HTML-comment
 * marker so the PR ends up with one comment that flips between
 * "deployed" and "cleaned up", not a stack of stale comments.
 * (Audit finding #14.)
 *
 * The platform is parameterized: the marker SLUG is a `bot_marker`
 * workflow_call input (kept unique per site), and each job builds the
 * marker as `<!-- ${BOT_MARKER_SLUG} -->` from that input. So we don't
 * assert a hardcoded per-site literal — we assert the SHARED, CONFIGURABLE
 * wiring: (1) the default slug, and (2) that BOTH the deploy and teardown
 * jobs derive their marker from the same `BOT_MARKER_SLUG` env, so they
 * can never disagree on which comment to update.
 */
const { test, expect } = require("./base");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");

// The site-agnostic default marker slug the platform ships
// (examples/site overrides it via the `bot_marker` input).
const DEFAULT_BOT_MARKER_SLUG = "cms-preview-bot";

// The HTML-comment marker each job constructs at runtime, built from the
// injected BOT_MARKER_SLUG env.
const MARKER_TEMPLATE = "`<!-- ${process.env.BOT_MARKER_SLUG} -->`";

function workflow() {
  return parseYaml(readWorkflow("deploy-preview.yml"));
}

test("deploy-preview exposes a configurable bot_marker input defaulting to the platform slug", () => {
  const wf = workflow();
  const input = wf.on.workflow_call.inputs.bot_marker;
  expect(input, "deploy-preview must accept a `bot_marker` workflow_call input").toBeTruthy();
  expect(
    input.default,
    `bot_marker should default to the site-agnostic '${DEFAULT_BOT_MARKER_SLUG}'`,
  ).toBe(DEFAULT_BOT_MARKER_SLUG);
});

for (const job of ["deploy-preview", "teardown-preview"]) {
  test(`${job} job builds its sticky-comment marker from the shared BOT_MARKER_SLUG input`, () => {
    const j = workflow().jobs[job];
    expect(j, `${job} job not found`).toBeTruthy();
    const text = JSON.stringify(j);
    // The job wires BOT_MARKER_SLUG from the bot_marker input...
    expect(
      text.includes("inputs.bot_marker"),
      `${job} must pass the configurable bot_marker input into BOT_MARKER_SLUG ` +
        `so the marker is site-parameterized, not hardcoded`,
    ).toBe(true);
    // ...and constructs the marker from that env, so deploy + teardown
    // share one marker and the same comment updates rather than spamming.
    expect(
      text.includes(MARKER_TEMPLATE),
      `${job} must build the marker as ${MARKER_TEMPLATE} so the deploy + ` +
        `teardown comments collapse onto one sticky comment`,
    ).toBe(true);
  });
}
