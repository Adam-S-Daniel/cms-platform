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

// One `${{ … }}` occurrence. `[\s\S]` rather than `.` is LOAD-BEARING: an
// expression may straddle a source line break, and that span has to match
// as one occurrence (see `scan`). Non-greedy so two interpolations stay
// two hits instead of merging into the span between them.
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
// of the body's first line, so `block.line` plus the newline count before
// a match is that match's absolute line — the anchor both the waiver
// window and the failure message need.
//
// SCANNED OVER THE WHOLE PARSED BODY, NEVER LINE BY LINE. A `${{ … }}` may
// legally straddle a source line break. The runner reads the span as ONE
// expression and substitutes it exactly as if it had been written on one
// line — actionlint's expression parser agrees, resolving contexts inside
// the span — but a per-line scan sees `${{` and `}}` on different lines
// and matches NEITHER, so the sink is invisible. Measured: `base.ref`
// reinstated into visual-regression.yml's `Fetch base ref` as
//
//     run: |
//       git fetch --no-tags origin "${{
//         github.event.pull_request.base.ref
//       }}"
//
// passed the per-line form of this lint AND actionlint, both exit 0 — a
// live, charset-injectable sink through the gate. The parser hands the
// body back as one scalar, where the expression is contiguous again, so
// matching there is both the structural read (house rule: parser, not
// regex over raw source) and the text the runner actually substitutes
// into. `abs` anchors to the line the `${{` OPENS on, which is also the
// strict direction for the waiver window: a marker sitting above the
// CLOSING `}}` — a line inside the expression itself — grants nothing.
function scan(blocks, fileLines, isUnsafe, kind) {
  const hits = [];
  for (const block of blocks) {
    const body = block.script;
    for (const m of body.matchAll(INTERPOLATION)) {
      if (!isUnsafe(m[0])) continue;
      const abs = block.line + body.slice(0, m.index).split("\n").length - 1;
      if (isWaived(fileLines, abs)) continue;
      hits.push(`line ${abs} (${kind}): ${m[0].replace(/\s+/g, " ").trim()}`);
    }
  }
  return hits;
}

// Both arms over one workflow's text → the sorted offender list. The
// per-file assertion below and the regression canary at the bottom BOTH
// go through here, so the canary exercises the shipped detector rather
// than a copy of it that could drift green while the real one rots.
function offenders(yaml) {
  const fileLines = yaml.split("\n");
  return [
    ...scan(runScripts(yaml), fileLines, (e) => RUN_UNSAFE.test(e), "run:"),
    ...scan(githubScriptBlocks(yaml), fileLines, () => true, "with.script"),
  ].sort();
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
    const base = path.basename(file);
    const hits = offenders(fs.readFileSync(file, "utf8"));

    test(`no expression is substituted into a code body (${base})`, () => {
      expect(
        hits,
        `${base} expands a \${{ }} expression into text that is then PARSED as ` +
          `code — a run: shell body or an actions/github-script with.script JS ` +
          `body. The runner substitutes the value before bash/eval parses, so the ` +
          `value becomes SOURCE, not data. ${HOWTO}`,
      ).toEqual([]);
    });
  }
});

// ── PERMANENT REGRESSION CANARY — the split-expression evasion ────────
//
// Synthetic workflow text driven through `offenders()`, the SHIPPED
// detector rather than a copy of it. Pure string in / hits out: no fs,
// no network, no clock.
//
// It guards the defect that shipped past this spec's first version. A
// `${{ }}` written across a source line break substitutes at runtime
// exactly as if it sat on one line, but the per-line scan then in place
// matched neither half — so a live, charset-injectable `base.ref` sink
// passed BOTH this lint and actionlint at exit 0. Reverting `scan()` to
// iterate body lines turns every RED case below green again.
//
// The three control cases carry as much weight as the red ones: an
// `env:`-bound value and a properly waived line must stay SILENT, or the
// canary would also pass on a detector that just flagged everything.
function wf(stepLines) {
  return ["on: push", "jobs:", "  j:", "    runs-on: ubuntu-latest", "    steps:"]
    .concat(stepLines.map((l) => "      " + l))
    .join("\n");
}

const CANARY = [
  {
    name: "a run: expression split across source lines is caught",
    yaml: wf([
      "- name: split",
      "  run: |",
      '    git fetch --no-tags origin "${{',
      "      github.event.pull_request.base.ref",
      '    }}"',
    ]),
    hits: ["line 8 (run:): ${{ github.event.pull_request.base.ref }}"],
  },
  {
    name: "a with.script expression split across source lines is caught",
    yaml: wf([
      "- name: split script",
      "  uses: actions/github-script@v7",
      "  with:",
      "    script: |",
      '      core.info("${{',
      "        github.event.pull_request.title",
      '      }}")',
    ]),
    hits: ["line 10 (with.script): ${{ github.event.pull_request.title }}"],
  },
  {
    // A folded scalar rejoins the split expression with SPACES rather
    // than newlines, so it is contiguous in the parsed value either way.
    name: "a split expression in a FOLDED (>) scalar is caught",
    yaml: wf([
      "- name: folded",
      "  run: >",
      '    git fetch --no-tags origin "${{',
      "    github.event.pull_request.base.ref",
      '    }}"',
    ]),
    hits: ["line 8 (run:): ${{ github.event.pull_request.base.ref }}"],
  },
  {
    // CONTROL. `env:` is a runner-expression context, never scanned —
    // binding is the fix, so it must not register as a hit.
    name: "an env-bound value is silent",
    yaml: wf([
      "- name: bound",
      "  env:",
      "    BASE: ${{ github.event.pull_request.base.ref }}",
      '  run: git fetch --no-tags origin "$BASE"',
    ]),
    hits: [],
  },
  {
    // CONTROL. The waiver window anchors to the line the `${{` OPENS on.
    name: "a waiver above the OPENING line still grants",
    yaml: wf([
      "- name: waived",
      "  run: |",
      "    # injection-allow: measured closed value space",
      '    echo "${{',
      "      github.event.pull_request.base.ref",
      '    }}"',
    ]),
    hits: [],
  },
  {
    // …and CANNOT be gained from an interior line of the split span. The
    // most tempting placement — immediately above the closing `}}` —
    // grants nothing, so splitting buys no waiver it could not already
    // have had.
    name: "a waiver above the CLOSING brace grants nothing",
    yaml: wf([
      "- name: sneaky",
      "  run: |",
      '    echo "${{',
      "      github.event.pull_request.base.ref",
      "    # injection-allow: interior line",
      '    }}"',
    ]),
    hits: [
      "line 8 (run:): ${{ github.event.pull_request.base.ref " +
        "# injection-allow: interior line }}",
    ],
  },
  {
    // The waiver has no split-across-lines analogue to exploit: a YAML
    // (or shell) comment cannot span lines, and WAIVER is matched per
    // raw source line, so half a marker grants nothing.
    name: "a waiver marker split across two lines grants nothing",
    yaml: wf([
      "- name: split marker",
      "  run: |",
      "    # injection-",
      "    # allow: marker split across lines",
      '    echo "${{ github.head_ref }}"',
    ]),
    hits: ["line 10 (run:): ${{ github.head_ref }}"],
  },
  {
    // The property the non-greedy quantifier protects, kept under the
    // whole-body scan: two occurrences must not merge into the span
    // between them.
    name: "two interpolations on one line stay two hits",
    yaml: wf([
      "- name: two",
      "  run: |",
      '    echo "${{ github.head_ref }}" "${{ github.base_ref }}"',
    ]),
    hits: [
      "line 8 (run:): ${{ github.base_ref }}",
      "line 8 (run:): ${{ github.head_ref }}",
    ],
  },
];

test.describe("the detector reads whole bodies, not source lines", () => {
  for (const c of CANARY) {
    test(c.name, () => {
      expect(
        offenders(c.yaml),
        `${c.name} — a \${{ }} may legally straddle a source line break; the ` +
          `runner substitutes the span as one expression regardless. Scanning ` +
          `the PARSED body (where it is contiguous) is what makes it visible, ` +
          `so a per-line scan here is a silent hole, not a style choice.`,
      ).toEqual(c.hits);
    });
  }
});
