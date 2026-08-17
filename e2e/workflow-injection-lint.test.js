// @lane: local — pure-fs lint of workflow YAML; no browser, no network
/*
 * THE INVARIANT: a `${{ … }}` expression must never be expanded into text
 * that is later PARSED as code — neither a `run:` shell body nor an
 * `actions/github-script` `with.script` JS body.
 *
 * WHY IT IS A SUBSTITUTION SINK, NOT A VARIABLE. The runner expands
 * `${{ … }}` into the command TEXT before bash (or the github-script
 * eval) ever sees it. So the value is not data — it is source. Measured:
 * a `base.ref` of `evil$(id -un)x` interpolated into
 *
 *     git fetch --no-tags origin "${{ github.event.pull_request.base.ref }}"
 *
 * renders as `git fetch --no-tags origin "evil$(id -un)x"` and bash runs
 * the `$(id -un)` — INSIDE the double quotes, no quote-breaking needed.
 * Binding the same value through `env:` and writing `"$BASE_REF"` leaves
 * the command text byte-identical whatever the value is, which is why
 * `env:` (shell) / `process.env` (github-script) is the fix and this lint
 * has no "quote it harder" escape hatch.
 *
 * The charset really does permit it: `git check-ref-format` accepts
 * `$( )`, backticks, `;`, `|`, `&` in a branch name, and `${IFS}`
 * substitutes for the space that IS rejected. A PR `number` (integer) and
 * a `head.sha` (40 hex) cannot carry a metacharacter, so those sinks are
 * hygiene rather than a live hole — but they are indistinguishable from
 * the dangerous shape at review time, and all of them are one `env:` line
 * from being safe. Hence: default-deny on the SHAPE.
 *
 * ── ARM 1 — `run:` bodies ────────────────────────────────────────────
 * Red on any interpolation mentioning `github.event.`, `github.head_ref`
 * or `github.base_ref`: the attacker-authored free strings. The DOT in
 * `github.event.` is load-bearing — `github.event_name` is a closed enum
 * the runner sets, in use today (dependabot-comment-sync.yml,
 * repo-settings-audit.yml), and must stay unflagged.
 *
 * Deliberately OUT of this arm: `github.run_id` / `github.repository`
 * (runner-set), `needs.*`, `inputs.*`, and `steps.*.outputs.*`. That is
 * NOT a claim that those classes are inherently safe — a step output is
 * only ever as closed as the step that produced it. Each current site was
 * traced to a closed value space individually (see docs/CI-INVARIANTS.md,
 * "Workflow interpolation sinks"), and `steps.*.outputs.*` keeps its own
 * dedicated coverage in deploy-preview-cms-slug.test.js, which this lint
 * does NOT subsume. Do not delete that guard.
 *
 * ── ARM 2 — `actions/github-script` `with.script` bodies ─────────────
 * Red on ANY interpolation. A github-script body is JS handed to an eval;
 * every dynamic value it needs is already reachable through `process.env`
 * or `context`, which is how 18 of the repo's 20 github-script steps (and
 * all of the composite actions) already read theirs. There is no value
 * class that needs to arrive as source text, so this arm has no allowlist
 * of "safe" expressions — the shape itself is the defect.
 *
 * SCOPE. Only `run:` and `with.script` bodies. `if:`, `env:` and every
 * other `with:` key are runner-EXPRESSION contexts (the value never
 * becomes code), so binding a value there is the fix, not the bug — and
 * scanning them would make the fix un-expressible.
 *
 * WAIVER (default-deny + inline escape hatch). An occurrence is permitted
 * only when `# injection-allow: <reason>` sits on its own source line or
 * the line immediately above. The window is matched against ABSOLUTE FILE
 * lines, not the extracted body array: a one-line plain `run:` scalar puts
 * its interpolation at body offset 0, so a body-relative "line above"
 * check cannot see the comment at the only place it fits — above the
 * `run:` key — and the waiver would silently fail to apply (measured).
 * `env:` binding needs no waiver: it removes the `${{ }}` from the body
 * entirely, into a map this lint does not scan.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, runScripts, githubScriptBlocks } = require("./workflow-yaml-utils");

// One `${{ … }}` occurrence. Non-greedy so two interpolations on one line
// stay two hits instead of merging into the span between them.
const INTERPOLATION = /\$\{\{[\s\S]*?\}\}/g;

// Tested against the WHOLE interpolation, not just its head, so a wrapped
// form (`${{ format('{0}', github.event.x) }}`) is caught too. No such
// form exists today; the current tree yields the identical hit set either
// way, so this costs nothing and closes the shape in advance.
const RUN_UNSAFE = /github\.event\.|github\.head_ref\b|github\.base_ref\b/;

// A bare `# injection-allow:` with no reason after it does not count.
const WAIVER = /#\s*injection-allow:\s*\S/;

function isWaived(fileLines, absLine) {
  const own = fileLines[absLine - 1] || "";
  const above = fileLines[absLine - 2] || "";
  return WAIVER.test(own) || WAIVER.test(above);
}

// `blocks` are {script, line} pairs where `line` is the 1-based FILE line
// of the body's first line, so `block.line + i` is the absolute line of
// body line `i` — the anchor both the waiver window and the failure
// message need.
function scan(blocks, fileLines, isUnsafe, kind) {
  const hits = [];
  for (const block of blocks) {
    block.script.split("\n").forEach((bodyLine, i) => {
      const abs = block.line + i;
      for (const expr of bodyLine.match(INTERPOLATION) || []) {
        if (!isUnsafe(expr)) continue;
        if (isWaived(fileLines, abs)) continue;
        hits.push(`line ${abs} (${kind}): ${expr.trim()}`);
      }
    });
  }
  return hits;
}

const HOWTO =
  "Bind the value through `env:` on the step (or its job) and read it as " +
  '`"$NAME"` in a run: body, or `process.env.NAME` in a github-script body — ' +
  "the command/JS text then stays byte-identical whatever the value is. " +
  "When binding is genuinely impossible, waive the line with a trailing (or " +
  "preceding) `# injection-allow: <reason>` comment.";

test.describe("workflow interpolation sinks are env-bound", () => {
  // One test per FILE, asserting that file's offender list is empty. A
  // test-per-OFFENDER design emits ZERO tests once the tree is clean, and
  // Playwright exits 1 on "No tests found" — so the lint's own success
  // state would fail its own verifier (measured). Per-file keeps the
  // file+line detail in the message and always emits tests.
  for (const file of listWorkflows()) {
    const yaml = fs.readFileSync(file, "utf8");
    const fileLines = yaml.split("\n");
    const base = path.basename(file);

    const offenders = [
      ...scan(runScripts(yaml), fileLines, (e) => RUN_UNSAFE.test(e), "run:"),
      ...scan(githubScriptBlocks(yaml), fileLines, () => true, "with.script"),
    ].sort();

    test(`no expression is substituted into a code body (${base})`, () => {
      expect(
        offenders,
        `${base} expands a \${{ }} expression into text that is then PARSED as ` +
          `code — a run: shell body or an actions/github-script with.script JS ` +
          `body. The runner substitutes the value before bash/eval parses, so the ` +
          `value becomes SOURCE, not data. ${HOWTO}`,
      ).toEqual([]);
    });
  }
});
