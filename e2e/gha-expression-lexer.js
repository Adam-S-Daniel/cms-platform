/*
 * The GitHub Actions expression lexer, shared by the workflow lints.
 *
 * Moved verbatim out of e2e/workflow-injection-lint.test.js so that
 * e2e/contributor-trust-boundary-rules.js reads expression PATHS with the
 * same hardened lexer instead of a second, weaker one (#536). In the
 * comments below, "this file" and "this lint" mean the injection lint,
 * where every measurement quoted here was taken; its canaries still
 * exercise these functions through the require.
 */
// ── AN OCCURRENCE'S BOUNDARY IS GRAMMAR, SO IT IS LEXED TOO ───────────
//
// Where a `${{ … }}` ENDS is a structural question, not a character
// search. `}}` inside a single-quoted literal is DATA — the expression
// lexer is mid-string there and does not close the span — so the obvious
// matcher, which this file used until this change,
//
//     /\$\{\{[\s\S]*?\}\}/g
//
// stops at the FIRST `}}` and hands the path lexer a TRUNCATED span.
// Everything after the literal brace is invisible. Measured, reinstated
// into visual-regression.yml's `Fetch base ref` step in place of its
// `env:` binding:
//
//     run: git fetch --no-tags origin "${{ '}}' != '' && github.…base.ref }}"
//
//     EXTRACTED  "${{ '}}"   → contextPaths []   → runUnsafe false → exit 0
//     real span  "${{ '}}' != '' && github.event.pull_request.base.ref }}"
//                → [["github","event","pull_request","base","ref"]] → unsafe
//
// `contextPaths` was already right; the BOUNDARY was wrong — and that put
// the repo's one charset-injectable sink back through this lint at exit 0
// for the third time, alongside `format('{1}', '}}', …)` and
// `'}}' == '' && 'x' || …`, and composing with the line-break split.
//
// The span is real, not a lex error: actionlint reads all of it. Swapping
// in `.title` (which IS on its untrusted-input list) reports at COLUMN 50,
// PAST the in-literal `}}`; and on a genuinely unterminated literal it
// says `unexpected EOF while lexing end of string literal`, which it does
// NOT say here. So this is a spelling the runner accepts, not one it
// rejects.
//
// This is the same house rule as `contextPaths` (parser for code
// structure, regex only for genuinely lexical concerns) applied to the
// layer above it. Enumerating one more alternative would have lost to the
// next spelling, exactly as the previous three rounds did.
//
// DEFAULT-DENY AT THE BOUNDARY — the rule the regex quietly broke. A span
// the grammar CANNOT read is never resolved to "safe" (the same rule
// `endOfString`'s -1 sentinel enforces one layer down). So extraction marks
// it UNREADABLE itself, in BOTH arms, without consulting `runUnsafe` —
// flagged, never silently skipped. `endOfString` is shared with the path
// lexer below (hoisted). Three ways a span is unreadable:
//
//   1. its string literal never closes;
//   2. it never reaches `}}` at all;
//   3. it steps over a character the expression lexer cannot lex (`LEXABLE`).
//
// (3) IS THE ONE THAT CLOSES THE LAST BOUNDARY RESIDUAL, and it is here so
// that this file's safety argument stops depending on actionlint. Without it,
// a span terminating at a `}}` that sits inside a construct the lexer does
// NOT model — `"…"`, backticks — yields a SHORT span with no paths and
// `unreadable: false`, and is silently skipped:
//
//     echo "${{ "}}" && github.event.pull_request.base.ref }}"
//                ^^ span cut here; everything behind it invisible
//
// That was benign only because `"` and `` ` `` are actionlint lex errors —
// an EXTERNAL dependency on a tool this same file proves twice over is no
// backstop (see UNSAFE_ROOTS: it stays silent on a field on its own untrusted
// list, one `env:` hop away). So the check is made locally instead.
//
// `LEXABLE` is read off the reference lexer's own error, which enumerates the
// legal token-start charset verbatim (measured, actionlint v1.7.7 on
// `${{ github.run_id + 1 }}`): *got unexpected character '+' while lexing
// expression, expecting 'a'..'z', 'A'..'Z', '_', '0'..'9', ''', '}', '(',
// ')', '[', ']', '.', '!', '<', '>', '=', '&', '|', '*', ',', ' '*. Two
// members are added to that list, each measured rather than assumed:
// `-`, which is a name CONTINUATION and not a token start (`github.event-name`
// lexes as ONE token — *property "event-name" is not defined*); and `\t`/`\n`
// /`\r`, which the ' ' in that message stands in for (a span carrying a tab,
// and one straddling a line break, both exit 0). `$` and `{` are absent on
// purpose — `{` outside a literal is a lex error, and the scan starts PAST the
// `${{` opener, so a nested `${{` is convicted by its `$`.
//
// It cannot false-positive on a workflow that parses — by the grammar, since
// every legal token starts with a listed character and literal CONTENT is
// skipped before the test — and it does not on this tree: across all 21 live
// spans the distinct set of characters stepped over outside literals is
// `" &()-.=JNOS_a-z|"`, of which ZERO are out of charset. Note the `-` and the
// `|`: `needs.generate.outputs.visually-different` and a `||` are both live, so
// neither addition is theoretical. This is deliberately NOT "flag any span
// containing a quote" — `'` is legal and its contents are data; the canary's
// safe-brace control pins that direction shut.
const LEXABLE = /[-A-Za-z0-9_'}()[\].!<>=&|*,\s]/;

function interpolations(body) {
  const out = [];
  let i = 0;
  for (;;) {
    const open = body.indexOf("${{", i);
    if (open < 0) return out;
    let k = open + 3;
    let end = -1;
    let unreadable = false;
    while (k < body.length) {
      if (body[k] === "'") {
        const after = endOfString(body, k);
        if (after < 0) {
          unreadable = true;
          break;
        }
        k = after;
      } else if (body[k] === "}" && body[k + 1] === "}") {
        end = k + 2;
        break;
      } else if (!LEXABLE.test(body[k])) {
        unreadable = true;
        break;
      } else k += 1;
    }
    if (unreadable) {
      // There is no true end to report — the literal swallowed the rest of
      // the body, or the lexer stopped on a character it cannot read. Fall
      // back to the naive first `}}`: the span still yields ONE occurrence,
      // anchored where it opened and readable in the failure message, and
      // `unreadable` is what convicts it.
      const naive = body.indexOf("}}", open + 3);
      end = naive < 0 ? body.length : naive + 2;
    } else if (end < 0) {
      unreadable = true;
      end = body.length;
    }
    out.push({ text: body.slice(open, end), index: open, unreadable });
    // Resume AFTER this span: a `${{` written inside a literal belongs to
    // the span that quoted it, not to a new occurrence.
    i = end;
  }
}

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

module.exports = { ANY, LEXABLE, interpolations, contextPaths, endOfString };
