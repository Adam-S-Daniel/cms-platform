// @lane: local — pure-fs lint on the release + platform-bump workflows
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml, allStrings } = require("./workflow-yaml-utils");

// Locks the release→bump chaining contract:
//
//   Cut release → dispatch each consumer's platform-bump (fail-open) →
//   bump PR enables auto-merge (fail-open) → site CI decides.
//
// The fail-open shape is the load-bearing part: a missing token, a failed
// dispatch, or a repo without auto-merge must degrade to the PRE-chaining
// behavior (human merge / hand dispatch) via ::warning — never fail the
// release job or the bump job. Losing that property would let a consumer
// outage (or an expired PAT) block cutting releases at all.

const RELEASE = path.join(__dirname, "..", ".github", "workflows", "release.yml");
const BUMP = path.join(__dirname, "..", ".github", "workflows", "platform-bump.yml");

function strings(file) {
  return allStrings(parseYaml(fs.readFileSync(file, "utf8"))).join("\n");
}

test.describe("release → bump chaining", () => {
  test("release.yml dispatches consumers' platform-bump after cutting", () => {
    const s = strings(RELEASE);
    expect(s, "release.yml must dispatch platform-bump.yml in consumers").toMatch(
      /gh workflow run platform-bump\.yml -R/,
    );
    expect(s, "adamdaniel.ai must be in the fan-out list").toContain("Adam-S-Daniel/adamdaniel.ai");
    expect(s, "jodidaniel.com must be in the fan-out list").toContain("jodidaniel/jodidaniel.com");
  });

  test("the fan-out is fail-open (warnings, not failures)", () => {
    const s = strings(RELEASE);
    expect(s, "missing-token path must warn and continue").toMatch(
      /::warning::no bump-dispatch token/,
    );
    expect(s, "failed-dispatch path must warn and continue").toMatch(
      /::warning::platform-bump dispatch failed/,
    );
  });

  test("failed-dispatch warnings name the exact hand re-dispatch command", () => {
    const s = strings(RELEASE);
    expect(s, "warnings must give the hand-dispatch command (no cron backstop)").toMatch(
      /dispatch by hand: gh workflow run platform-bump\.yml -R \$\{repo\}/,
    );
    expect(s, "no weekly-cron promise may remain").not.toMatch(/weekly/i);
  });

  test("the template platform-bump caller has no schedule, only workflow_dispatch", () => {
    const caller = parseYaml(
      fs.readFileSync(
        path.join(__dirname, "..", "examples", "site", ".github", "workflows", "platform-bump.yml"),
        "utf8",
      ),
    );
    // js-yaml/yaml may surface `on:` as the string key "on" or boolean true.
    const on = caller.on ?? caller[true];
    expect(on, "caller must have an on: block").toBeTruthy();
    expect(Object.keys(on)).toContain("workflow_dispatch");
    expect(Object.keys(on), "weekly backstop removed: releases dispatch it").not.toContain("schedule");
  });

  test("platform-bump enables auto-merge on the bump PR, fail-open", () => {
    const s = strings(BUMP);
    expect(s, "bump PR must enable auto-merge").toMatch(/gh pr merge --auto --squash/);
    expect(s, "auto-merge enablement must degrade to a warning").toMatch(
      /::warning::could not enable auto-merge/,
    );
  });
});
