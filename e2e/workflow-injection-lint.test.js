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
 * Red on any interpolation that REFERENCES `github.event`,
 * `github.head_ref` or `github.base_ref` — the attacker-authored free
 * strings — in ANY spelling. The question asked is structural ("does this
 * expression reference attacker-influenced context at all"), so the
 * matcher lexes expression PATHS rather than testing expression text
 * (see `contextPaths`). `github.event_name` is a closed enum the runner
 * sets, in use today (dependabot-comment-sync.yml,
 * repo-settings-audit.yml), and must stay unflagged; segment-wise
 * comparison is what keeps it unflagged in every spelling, rather than
 * the trailing dot of a substring match.
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

// ── ARM 1 MATCHES EXPRESSION PATHS, NOT EXPRESSION TEXT ──────────────
//
// An Actions expression has its own grammar, and ONE context reference has
// many spellings that all denote the identical runtime value. Index syntax
// is documented as interchangeable with property dereference, the lexer
// treats whitespace (spaces AND tabs) as insignificant, property names and
// context names are CASE-INSENSITIVE, and a `${{ }}` may straddle a source
// line break. Every one of these reads the same branch name:
//
//     github.event.pull_request.base.ref
//     github['event']['pull_request']['base']['ref']
//     github.event['pull_request'].base['ref']
//     github . event . pull_request . base . ref
//     GitHub.Event.Pull_Request.Base.Ref
//
// Measured against actionlint v1.7.7's own expression parser, which
// normalises each of them back to the dot path (`github.event.…`) — for
// `pull_request.title`, which IS on its untrusted-input list, all five
// spellings report *"github.event.pull_request.title" is potentially
// untrusted*. So the equivalence is not a guess about the grammar.
//
// A regex over the expression TEXT sees only the first. This lint's
// previous matcher was `/github\.event\.|github\.head_ref\b|…/`, and the
// index form reinstated into visual-regression.yml's `Fetch base ref` step
// passed it at exit 0 — the repo's one charset-injectable sink back through
// the gate, respelled, exactly as the previous round had let it through by
// straddling a line break. Two evasions, one root cause: matching
// characters where the runner matches structure.
//
// actionlint is NO backstop for this sink. It does normalise the spellings,
// but `base.ref` is not on its untrusted-input list in ANY of them —
// measured: all five above pass actionlint at exit 0 in a `run:` body, as
// do `toJSON(github.event)` and `toJSON(github['event'])`. For the one
// value in this repo whose charset permits `$( )`, this lint is the only
// net, so it has to read the grammar rather than the characters.
//
// That is the house rule (parser for code structure, regex only for
// genuinely lexical concerns) applied one layer deeper than the YAML: an
// expression path IS code structure, and enumerating spellings in a regex
// is the losing game — each round of it has lost to the next spelling.

// A path segment whose name is not statically knowable: a dynamic index
// (`github[inputs.k]`), a function-computed one (`github[format(…)]`), a
// star filter (`github.event.*`), or an unterminated index. It matches ANY
// name, so a path carrying one is treated as possibly landing on an unsafe
// member — default-deny, as everywhere else in this file. Measured on the
// tree: 149 code bodies, 21 interpolations, ZERO dynamic-index or star
// forms — so this costs nothing today and closes the shape in advance.
const ANY = Symbol("unresolvable-segment");

// A property name. The hyphen is REAL and load-bearing: the grammar has no
// subtraction operator, so `a-b` lexes as one name. Measured — actionlint
// reports `github.pull-request` as *property "pull-request" is not
// defined* (one token, not two), and rejects `github.run_number - 1` as a
// lex error. The live tree needs it: `needs.generate.outputs.
// visually-different` (visual-regression.yml).
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_-]/;

// Context and property names are case-INSENSITIVE, so a segment is
// compared folded. Measured: actionlint resolves `GitHub.Event.
// Pull_Request.Title`, `github.HEAD_REF` and `GITHUB.EVENT_NAME` to their
// lowercase paths. This is the spelling the recovered draft of this fix
// still missed, and it is why the fold happens at the SEGMENT level rather
// than as one more alternative in a pattern.
//
// Index literals are folded too, deliberately and one step BEYOND what is
// provable here: actionlint treats them as case-SENSITIVE (it rejects
// `github['EVENT']` as *property "EVENT" is not defined*), but actionlint
// is a second implementation, and the runner's contexts are dictionaries
// whose case behaviour cannot be measured offline. Folding can only ADD
// hits, never drop one, and `github['EVENT']` is not a spelling any
// correct workflow uses — so the conservative branch is the right one and
// the disagreement is recorded rather than resolved. `toLowerCase` (not
// `toLocaleLowerCase`) keeps it locale-independent and deterministic.
const fold = (name) => name.toLowerCase();

const isSpace = (ch) => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function skipSpace(s, i) {
  let k = i;
  while (k < s.length && isSpace(s[k])) k += 1;
  return k;
}

// Index of the char after the single-quoted string opening at `s[i]`.
// `''` is the grammar's only escape and `'` its only string delimiter — a
// DOUBLE quote is a lex error, not a second spelling (measured: actionlint
// rejects `github["event"]`, and its error enumerates the legal charset
// with `"` absent).
function endOfString(s, i) {
  let k = i + 1;
  while (k < s.length) {
    if (s[k] !== "'") k += 1;
    else if (s[k + 1] === "'") k += 2;
    else return k + 1;
  }
  // UNTERMINATED, reported as -1 rather than as end-of-input. The two must
  // not be conflated: returning `k` made an unterminated literal look like
  // one that closed on the final character, so `github['` resolved to the
  // segment `" }"` (the trailing interpolation text) instead of falling
  // through to `ANY` — silently RESOLVING a name the grammar cannot read,
  // which is the one direction default-deny forbids. Caught by the
  // adversarial pass over this lexer, not by the spellings under review.
  return -1;
}

// Index of the `]` closing the `[` at `s[i]`, skipping nested brackets and
// string literals. An unterminated index (or an unterminated literal inside
// one) runs to end-of-input, so it still yields `ANY` rather than silently
// ending the path early.
function endOfIndex(s, i) {
  let depth = 0;
  for (let k = i; k < s.length; k += 1) {
    if (s[k] === "'") {
      const after = endOfString(s, k);
      if (after < 0) return s.length;
      k = after - 1;
    } else if (s[k] === "[") depth += 1;
    else if (s[k] === "]" && (depth -= 1) === 0) return k;
  }
  return s.length;
}

// The value of `inner` when the whole index is EXACTLY one properly closed
// string literal; null for anything else — a number, a context reference, a
// function call, or an unterminated quote — i.e. an index whose name is not
// statically knowable.
function indexLiteral(inner) {
  if (inner[0] !== "'") return null;
  return endOfString(inner, 0) === inner.length
    ? inner.slice(1, -1).split("''").join("'")
    : null;
}

// Every context reference in an expression, as an array of folded SEGMENTS.
// Lexed, not regexed, so all five spellings above return the one path
// ["github","event","pull_request","base","ref"]. The `${{`/`}}`
// delimiters lex as non-name noise, so a whole interpolation occurrence can
// be handed in as-is.
function contextPaths(expr) {
  const paths = [];
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      // A string literal is DATA — the grammar has no eval, so a path
      // spelled inside quotes references nothing (measured: actionlint
      // raises no untrusted-input finding for
      // `inputs.q == 'github.event.pull_request.title'`). Skipping it also
      // drops a false positive the text regex had. An unterminated literal
      // swallows the rest of the expression — there is no name after it the
      // grammar could read.
      const after = endOfString(expr, i);
      i = after < 0 ? expr.length : after;
      continue;
    }
    if (!NAME_START.test(expr[i])) {
      i += 1;
      continue;
    }
    let end = i;
    while (end < expr.length && NAME_CHAR.test(expr[end])) end += 1;
    const head = expr.slice(i, end);
    i = end;
    // A function NAME heads no path (`toJSON(github.event)`); the walk
    // continues into the arguments, where the real reference lives.
    if (expr[skipSpace(expr, i)] === "(") continue;
    const path = [fold(head)];
    for (;;) {
      const at = skipSpace(expr, i);
      if (expr[at] === ".") {
        const seg = skipSpace(expr, at + 1);
        if (expr[seg] === "*") {
          path.push(ANY);
          i = seg + 1;
          continue;
        }
        if (seg >= expr.length || !NAME_START.test(expr[seg])) break;
        let stop = seg;
        while (stop < expr.length && NAME_CHAR.test(expr[stop])) stop += 1;
        path.push(fold(expr.slice(seg, stop)));
        i = stop;
        continue;
      }
      if (expr[at] === "[") {
        const close = endOfIndex(expr, at);
        const inner = expr.slice(at + 1, close).trim();
        const literal = indexLiteral(inner);
        path.push(literal === null ? ANY : fold(literal));
        // A dynamic index may itself reference context — lex it too.
        if (literal === null) paths.push(...contextPaths(inner));
        i = close + 1;
        continue;
      }
      break;
    }
    paths.push(path);
  }
  return paths;
}

// The attacker-authored free strings, as folded segment paths.
const UNSAFE_ROOTS = [
  ["github", "event"],
  ["github", "head_ref"],
  ["github", "base_ref"],
];

// A path is unsafe when it sits on the same branch as an unsafe root, in
// EITHER direction. Descendant: `github.event.pull_request.base.ref`.
// Ancestor: `toJSON(github.event)`, `toJSON(github)` and a bare
// `${{ github }}` serialise the whole attacker payload into the body —
// strictly worse than any single field — so referencing a node that
// CONTAINS an unsafe root counts too. The text regex's trailing dot missed
// all three (measured: `${{ toJSON(github.event) }}` passed it at exit 0,
// and actionlint reports nothing for it either).
//
// Comparison is SEGMENT-WISE, which is what preserves the
// `github.event_name` carve-out structurally rather than by special case:
// `event_name` is not the segment `event` in ANY spelling, so
// `github['event_name']` and `GITHUB.EVENT_NAME` stay silent for the same
// reason the dotted form does. A substring matcher has to re-encode that
// distinction as a trailing dot, and the trailing dot is precisely what
// made `toJSON(github.event)` invisible.
function onUnsafeBranch(path) {
  return UNSAFE_ROOTS.some((root) => {
    const shared = Math.min(path.length, root.length);
    for (let i = 0; i < shared; i += 1) {
      if (path[i] !== root[i] && path[i] !== ANY) return false;
    }
    return true;
  });
}

function runUnsafe(interpolation) {
  return contextPaths(interpolation).some(onUnsafeBranch);
}

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
    ...scan(runScripts(yaml), fileLines, runUnsafe, "run:"),
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

// ── PERMANENT REGRESSION CANARY — the two respelling evasions ─────────
//
// Synthetic workflow text driven through `offenders()`, the SHIPPED
// detector rather than a copy of it. Pure string in / hits out: no fs,
// no network, no clock.
//
// It guards two defects that each shipped past an earlier version of this
// spec, and each let the SAME live, charset-injectable `base.ref` sink in
// visual-regression.yml's `Fetch base ref` step through BOTH this lint and
// actionlint at exit 0:
//
//   1. WHERE the expression sits. A `${{ }}` written across a source line
//      break substitutes at runtime exactly as if it sat on one line, but
//      the per-line scan then in place matched neither half. Reverting
//      `scan()` to iterate body lines turns those cases green again.
//   2. HOW the expression is SPELLED. Index syntax, mixed dot-and-index,
//      insignificant whitespace and CASE are documented, runtime-identical
//      spellings of the same dot path, and the `/github\.event\./` text
//      regex then in place saw none of them. Reverting `runUnsafe` to that
//      regex turns those cases green again.
//
// The two axes COMPOSE — an index-form expression also split across lines
// is a case of its own below — which is the argument for matching parsed
// bodies and lexed path segments instead of enumerating spellings. Each
// enumeration has lost to the next spelling; the case form below is the one
// that a draft closing only the three spellings named in review still let
// through (measured).
//
// The control cases carry as much weight as the red ones: an `env:`-bound
// value, a properly waived line, `github.event_name` in EVERY spelling, a
// path quoted inside a string literal, and the safe `github.*` members must
// all stay SILENT, or the canary would also pass on a detector that just
// flagged everything.
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
    // GitHub documents index syntax as interchangeable with property
    // dereference. This exact body, in the real `Fetch base ref` step,
    // passed both this lint and actionlint at exit 0 before the lexer.
    name: "an INDEX-syntax reference is caught",
    yaml: wf([
      "- name: index",
      "  run: |",
      "    git fetch --no-tags origin " +
        "\"${{ github['event']['pull_request']['base']['ref'] }}\"",
    ]),
    hits: ["line 8 (run:): ${{ github['event']['pull_request']['base']['ref'] }}"],
  },
  {
    // Nothing forces one spelling per expression: dots and indexes mix
    // freely, so enumerating whole spellings never closes the shape.
    name: "a MIXED dot-and-index reference is caught",
    yaml: wf([
      "- name: mixed",
      "  run: |",
      "    git fetch --no-tags origin \"${{ github.event['pull_request'].base['ref'] }}\"",
    ]),
    hits: ["line 8 (run:): ${{ github.event['pull_request'].base['ref'] }}"],
  },
  {
    // The two evasion axes COMPOSE: index syntax straddling a line break
    // needs the parsed-body scan AND the path lexer to be seen at all.
    name: "an index reference SPLIT across source lines is caught",
    yaml: wf([
      "- name: index split",
      "  run: |",
      '    git fetch --no-tags origin "${{ github[',
      "      'event']['pull_request']['base'][",
      "      'ref'] }}\"",
    ]),
    hits: ["line 8 (run:): ${{ github[ 'event']['pull_request']['base'][ 'ref'] }}"],
  },
  {
    // Whitespace is insignificant to the expression lexer.
    name: "a SPACED dot reference is caught",
    yaml: wf([
      "- name: spaced",
      "  run: |",
      '    echo "${{ github . event . pull_request . base . ref }}"',
    ]),
    hits: ["line 8 (run:): ${{ github . event . pull_request . base . ref }}"],
  },
  {
    // …and TABS are whitespace too, so `/ /` would not have been enough.
    name: "a TAB-separated reference is caught",
    yaml: wf([
      "- name: tabbed",
      "  run: |",
      '    echo "${{ github\t.\tevent\t.\tpull_request\t.\tbase\t.\tref }}"',
    ]),
    hits: ["line 8 (run:): ${{ github . event . pull_request . base . ref }}"],
  },
  {
    // THE FOURTH SPELLING. Context and property names are case-insensitive
    // — actionlint resolves this to `github.event.pull_request.base.ref` —
    // and a fix that closed only index/mixed/spaced still passed it
    // (measured). Hence folding at the SEGMENT level, not one more pattern
    // alternative.
    name: "a CASE-VARIED reference is caught",
    yaml: wf([
      "- name: cased",
      "  run: |",
      '    echo "${{ GitHub.Event.Pull_Request.Base.Ref }}"',
    ]),
    hits: ["line 8 (run:): ${{ GitHub.Event.Pull_Request.Base.Ref }}"],
  },
  {
    // Case and index compose as freely as everything else, and this one
    // reaches `github.base_ref` — a different unsafe root — in the same
    // breath, so the fold must apply to index literals too.
    name: "a case-varied INDEX reference is caught",
    yaml: wf([
      "- name: cased index",
      "  run: |",
      "    echo \"${{ GITHUB['Event'].BASE_REF }}\"",
    ]),
    hits: ["line 8 (run:): ${{ GITHUB['Event'].BASE_REF }}"],
  },
  {
    // An UNRESOLVABLE segment: the index is a context reference, so no
    // matcher can know statically which member it lands on. Default-deny
    // says treat it as possibly the unsafe one.
    name: "a DYNAMIC index segment is caught",
    yaml: wf([
      "- name: dynamic",
      "  run: |",
      "    echo \"${{ github[inputs.key]['pull_request']['base']['ref'] }}\"",
    ]),
    hits: ["line 8 (run:): ${{ github[inputs.key]['pull_request']['base']['ref'] }}"],
  },
  {
    // …and a function-computed index is the same class. `format('{0}',…)`
    // is the readiest way to spell a name without writing it.
    name: "a function-computed index segment is caught",
    yaml: wf([
      "- name: fn index",
      "  run: |",
      "    echo \"${{ github[format('{0}', 'event')].pull_request.base.ref }}\"",
    ]),
    hits: ["line 8 (run:): ${{ github[format('{0}', 'event')].pull_request.base.ref }}"],
  },
  {
    // A star filter is an unresolvable segment with its own syntax. BOTH
    // positions are pinned on purpose, because they are not equally
    // load-bearing: a star LATE in the path leaves the literal text
    // `github.event.` standing in front of it, so the old regex caught that
    // one by accident, while a star AT the position of `event` erased the
    // only thing that regex could see (measured — old matcher green).
    // Same class, and only the segment lexer covers both, which is the
    // whole argument against trusting a text prefix.
    name: "a STAR filter segment is caught at any position",
    yaml: wf([
      "- name: star",
      "  run: |",
      '    echo "${{ github.*.pull_request.base.ref }}"',
      '    echo "${{ github.event.pull_request.*.ref }}"',
    ]),
    hits: [
      "line 8 (run:): ${{ github.*.pull_request.base.ref }}",
      "line 9 (run:): ${{ github.event.pull_request.*.ref }}",
    ],
  },
  {
    // An UNTERMINATED index literal must fall through to `ANY`, never
    // resolve. A defect the adversarial pass over the lexer itself found,
    // not one of the spellings under review: `endOfString` used to return
    // end-of-input for an unclosed quote, indistinguishable from a quote
    // that closed on the final character, so `github['ev` resolved to the
    // segment `"ev }"` — swallowing the trailing interpolation text as a
    // NAME the grammar cannot read, and calling it safe. Default-deny
    // forbids exactly that direction, hence the -1 sentinel.
    //
    // The FIRST line is the witness (unclosed QUOTE — green before the
    // sentinel, measured); the second is coverage only (the quote closes,
    // just the `]` is missing, so the trailing junk already defeated
    // `indexLiteral` either way). Both are here because only one of them
    // tests the guard and it is not the one that looks more broken.
    name: "an unterminated index literal is caught, not resolved",
    yaml: wf([
      "- name: unterminated",
      "  run: |",
      "    echo \"${{ github['ev }}\"",
      "    echo \"${{ github['event' }}\"",
    ]),
    hits: [
      "line 8 (run:): ${{ github['ev }}",
      "line 9 (run:): ${{ github['event' }}",
    ],
  },
  {
    // Parenthesised grouping is yet another legal spelling of the same
    // reference — actionlint normalises `(github).event.pull_request.title`
    // to the dot path. The lexer stops the path at the `)`, so this is
    // caught by the ANCESTOR half of the branch rule (it references
    // `github`, which CONTAINS `github.event`) rather than by resolving the
    // full path. Caught either way; pinned so a future "tighten the
    // ancestor rule" change cannot quietly reopen it.
    name: "a PARENTHESISED root reference is caught",
    yaml: wf([
      "- name: parens",
      "  run: |",
      '    echo "${{ (github).event.pull_request.base.ref }}"',
    ]),
    hits: ["line 8 (run:): ${{ (github).event.pull_request.base.ref }}"],
  },
  {
    // DELIBERATE WIDENING, decided rather than inherited. `toJSON(github)`
    // and `toJSON(github.event)` serialise the WHOLE attacker payload into
    // the body — strictly worse than any single field — yet the text
    // regex's trailing dot passed all three of these, and actionlint
    // reports nothing for them either (measured, exit 0). Segment matching
    // counts a reference to an ANCESTOR of an unsafe root as unsafe.
    name: "toJSON of the event object, and a bare github, are caught",
    yaml: wf([
      "- name: dump",
      "  run: |",
      '    echo "${{ toJSON(github.event) }}"',
      "    echo \"${{ toJSON(github['event']) }}\"",
      '    echo "${{ github }}"',
    ]),
    hits: [
      "line 10 (run:): ${{ github }}",
      "line 8 (run:): ${{ toJSON(github.event) }}",
      "line 9 (run:): ${{ toJSON(github['event']) }}",
    ],
  },
  {
    // CONTROL, and the load-bearing half of the widening.
    // `github.event_name` is a closed enum the runner sets, live in
    // dependabot-comment-sync.yml and repo-settings-audit.yml. Segment-wise
    // comparison keeps it silent in EVERY spelling without a special case:
    // `event_name` is simply not the segment `event`. A matcher that
    // normalised index syntax by rewriting `['x']` to `.x` and then
    // substring-tested `github.event` (no trailing dot) would flag all
    // three of these and red those two workflows.
    name: "github.event_name stays silent in every spelling",
    yaml: wf([
      "- name: enum",
      "  run: |",
      '    echo "${{ github.event_name }}"',
      "    echo \"${{ github['event_name'] }}\"",
      '    echo "${{ GITHUB . EVENT_NAME }}"',
    ]),
    hits: [],
  },
  {
    // CONTROL. A path spelled inside a string LITERAL references nothing —
    // the grammar has no eval — so it must not register. The text regex
    // flagged this; no such case exists in the tree, but the lexer dropping
    // it is a behaviour change worth pinning.
    name: "a path inside a string literal is silent",
    yaml: wf([
      "- name: quoted",
      "  run: |",
      "    echo \"${{ inputs.q == 'github.event.pull_request.base.ref' }}\"",
    ]),
    hits: [],
  },
  {
    // CONTROL for the ANCESTOR half of the widening: flagging a reference
    // that CONTAINS an unsafe root must not spill onto `github`'s
    // runner-set siblings.
    //
    // The third line is also the HYPHEN witness, and it is the one line here
    // that changes verdict if `NAME_CHAR` loses its `-`: `base_ref-ish`
    // would then lex as the segment `base_ref`, turning an unrelated
    // property into a FALSE POSITIVE on an unsafe root. actionlint confirms
    // the boundary — it reports `github.event-name` as *property
    // "event-name" is not defined*, one token, and rejects
    // `github.run_number - 1` as a lex error, because the grammar has no
    // subtraction operator for `-` to be.
    //
    // The live `visually-different` line, by contrast, is COVERAGE not a
    // witness: dropping the hyphen splits it into two paths that are both
    // still safe, so it stays green either way (measured). It is here
    // because it is the real usage in visual-regression.yml.
    name: "runner-set github members and hyphenated names are silent",
    yaml: wf([
      "- name: safe",
      "  run: |",
      '    echo "${{ github.repository }} ${{ github.run_id }}"',
      '    echo "${{ needs.generate.outputs.visually-different }}"',
      '    echo "${{ github.base_ref-ish }} ${{ github.event-name }}"',
    ]),
    hits: [],
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

test.describe("the detector reads parsed bodies and lexed paths", () => {
  for (const c of CANARY) {
    test(c.name, () => {
      expect(
        offenders(c.yaml),
        `${c.name} — a \${{ }} may straddle a source line break, and ONE ` +
          `context reference has many runtime-identical spellings (index, ` +
          `mixed, spaced, tabbed, case-varied, dynamic). The runner resolves ` +
          `them all to the same value, so scanning the PARSED body (where the ` +
          `span is contiguous) and comparing LEXED, case-folded path SEGMENTS ` +
          `(where the spellings converge) is what makes the sink visible. A ` +
          `per-line scan, or any regex over expression text, is a silent hole ` +
          `— not a style choice.`,
      ).toEqual(c.hits);
    });
  }
});
