// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * Regression test: every workflow must declare a dynamic `run-name:`
 * following the `<trigger> — <context>` grammar (issue #1776).
 *
 * Without `run-name:`, GitHub auto-generates a run's display title from
 * the trigger event, so the SAME workflow gets different-looking titles
 * depending on what fired it (a push borrows the head commit message; a
 * dispatch falls back to the static `name:`; a PR borrows the PR title;
 * schedule/workflow_run fall back to other defaults). `run-name:` is the
 * one knob that fixes the per-run title deterministically — it supports
 * expressions, is evaluated at run-start, and (unlike `name:`) is the
 * actual title shown in the Actions tab.
 *
 * This lint is what prevents a future workflow from regressing to an
 * inconsistent auto-title. For every `.github/workflows/*.yml` it asserts:
 *   (a) a top-level `run-name:` key exists and is a non-empty string;
 *   (b) it contains a `${{` expression (dynamic, not a hard-coded string);
 *   (c) every workflow declaring more than one event includes a
 *       `github.event_name ==` (or `github.event.action ==`) branch, so
 *       the title actually varies by trigger instead of mislabelling some
 *       events.
 *
 * Future caveat: a workflow triggered PURELY by `workflow_call` never
 * displays its own run-name (the title shown is the caller's), so such a
 * file could be exempted from (b)/(c). None exist today — every reusable
 * workflow here also declares a directly-dispatchable trigger — so the
 * exemption is documented but not yet wired in. Add a `workflow_call`-only
 * skip here if one is ever introduced.
 *
 * `run-name:` may only reference the `github` and `inputs` contexts
 * (`vars`/`env`/`secrets`/`steps`/`jobs`/`runner` are unavailable) — see
 * AGENTS.md "Workflow run naming" for the grammar and building blocks.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, parseYaml, events } = require("./workflow-yaml-utils");

for (const file of listWorkflows()) {
  const name = path.basename(file);

  test(`${name} :: declares a dynamic run-name`, () => {
    const doc = parseYaml(fs.readFileSync(file, "utf8")) || {};
    const runName = doc["run-name"];

    expect(
      typeof runName === "string" && runName.trim() !== "",
      `${name} must declare a top-level \`run-name:\` as a non-empty ` +
        `string (line 2, after \`name:\`). Without it, GitHub ` +
        `auto-titles each run from the trigger event and the Actions tab ` +
        `becomes inconsistent. See AGENTS.md "Workflow run naming".`,
    ).toBe(true);

    expect(
      runName.includes("${{"),
      `${name} :: run-name must be a \`\${{ … }}\` expression (the ` +
        `\`<trigger> — <context>\` grammar), not a hard-coded string — ` +
        `otherwise it can't reflect what triggered the run.`,
    ).toBe(true);

    // The expression must be balanced (close the `${{`). A single-line
    // `run-name: ${{ format('PR #{0} …') }}` left UNQUOTED has its `#`
    // parsed by YAML as an inline comment, truncating the scalar at `#`
    // to `${{ format('PR` — which still contains `${{` (so the check
    // above passes) but is an unterminated expression that actionlint
    // rejects and GitHub renders wrong. Requiring `}}` catches that:
    // single-line run-names containing `#` must be quoted.
    expect(
      runName.includes("}}"),
      `${name} :: run-name expression is truncated (no closing \`}}\`). ` +
        `A single-line \`run-name: \${{ … }}\` containing \`#\` must be ` +
        `wrapped in quotes ("\${{ … }}") so YAML doesn't treat the \`#\` ` +
        `as a comment and cut off the expression. See AGENTS.md ` +
        `"Workflow run naming".`,
    ).toBe(true);
  });

  test(`${name} :: multi-event run-name branches on the trigger`, () => {
    const doc = parseYaml(fs.readFileSync(file, "utf8")) || {};
    const declared = events(doc.on);
    const runName = typeof doc["run-name"] === "string" ? doc["run-name"] : "";

    // Single-event workflows need no per-event branch — their one trigger
    // fully determines the title. Only multi-event files must branch.
    if (declared.length <= 1) return;

    const branches =
      runName.includes("github.event_name ==") || runName.includes("github.event.action ==");

    expect(
      branches,
      `${name} declares ${declared.length} events ` +
        `(${declared.join(", ")}) but its run-name has no ` +
        `\`github.event_name ==\` (or \`github.event.action ==\`) branch — ` +
        `so runs from different triggers would share one mislabelled ` +
        `title. Branch per event with the \`cond && 'A' || 'B'\` idiom. ` +
        `See AGENTS.md "Workflow run naming".`,
    ).toBe(true);
  });
}
