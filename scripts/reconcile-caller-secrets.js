#!/usr/bin/env node
// Reconcile each consumer thin caller's per-job `secrets:` map with the
// canonical examples/site template.
//
// WHY THIS EXISTS. platform-bump moves pins, seeds new callers, retires old
// ones and reconciles `required_contexts`, but nothing moved a caller's
// `secrets:` map. v0.1.113 (#467) added `app_private_key` to the
// dependabot-rearm-sweep template; neither consumer received it, and both
// v0.1.114 bump PRs (adamdaniel.ai#3891, jodidaniel.com#281) failed
// pin-consistency with `workflow-content: DRIFT ... job rearm secrets: map`
// until it was hand-added. check-platform-pin-consistency.js compares the map
// WHOLE and SYMMETRICALLY against the template at the consumer's OWN
// platform_ref, so the fix has to ride the bump commit: split off, it fails in
// one direction before the bump lands and in the other after.
//
// READ WITH A PARSER, WRITE WITH A SPLICE, THEN RE-PARSE. Both sides are read
// with the `yaml` package (never a line scanner — anchors and aliases). Drift
// is decided with the checker's OWN structuralShape(), so "reconciled" means
// exactly "the checker agrees". Re-serializing the parsed document would
// reformat most callers (it does not round-trip them byte-for-byte), so the
// write is a splice of the `secrets:` lines only, using the parser's source
// ranges: kept keys keep the consumer's text and comments, added keys bring the
// template's text and comments re-indented to the consumer's style. The result
// is re-parsed and must (a) match the template's map per structuralShape and
// (b) be otherwise identical to the original document, or the file is left
// unchanged and reported MANUAL.
//
// Usage:
//   node scripts/reconcile-caller-secrets.js --canonical-dir DIR --workflows-dir DIR
//
// Only callers present on BOTH sides are touched, and only jobs present in both.
// Seeding a missing caller and retiring a de-dictated one are platform-bump's
// other passes; a site-authored workflow has no canonical counterpart and is
// never read.
//
// Prints one line per changed job and a closing SUMMARY, then exits:
//   0  every drifted map was reconciled (or none drifted)
//   3  at least one MANUAL line: the operator must fix that caller by hand
// Any other exit code is unexpected; the caller should treat it as MANUAL.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
// Reuses the checker's own YAML resolution and call-interface shape, so this
// script and the guard it satisfies can never disagree on what "drift" means.
// The checker only runs its CLI when it is the main module.
const { structuralShape } = require("./check-platform-pin-consistency.js");

function loadYaml() {
  const candidates = [
    undefined,
    path.resolve(__dirname, "..", "e2e", "node_modules"),
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    try {
      return require(base ? require.resolve("yaml", { paths: [base] }) : require.resolve("yaml"));
    } catch {
      /* try next */
    }
  }
  throw new Error("Cannot resolve the `yaml` parser (npm install yaml).");
}
const YAML = loadYaml();

class Manual extends Error {}

function argOf(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// ── Source-position helpers ──────────────────────────────────────────────────
function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}
function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
const indentOf = (line) => line.length - line.trimStart().length;
const isComment = (line) => line.trimStart().startsWith("#");
const isBlank = (line) => line.trim() === "";

function parse(src) {
  const doc = YAML.parseDocument(src);
  if (doc.errors.length) throw new Manual("does not parse");
  return doc;
}

// The last source line a node's CONTENT occupies (never a trailing comment or
// blank line that the parser folded into the node's range).
function lastLine(node, starts, lines) {
  if (YAML.isMap(node) && !node.flow && node.items.length) {
    const last = node.items[node.items.length - 1];
    return lastLine(last.value ?? last.key, starts, lines);
  }
  if (YAML.isSeq(node) && !node.flow && node.items.length) {
    return lastLine(node.items[node.items.length - 1], starts, lines);
  }
  let l = lineOf(starts, Math.max(node.range[0], node.range[1] - 1));
  while (l > 0 && isBlank(lines[l])) l--;
  return l;
}

// A block-map pair's lines: [first, last]. `first` walks up over comment lines
// directly above the key (the parser attaches them to it) but stops at a blank
// line or at `floor`, so a blank-separated comment stays where it is.
function pairSpan(pair, starts, lines, floor) {
  const keyLine = lineOf(starts, pair.key.range[0]);
  let first = keyLine;
  while (first - 1 > floor && isComment(lines[first - 1])) first--;
  const last = pair.value ? lastLine(pair.value, starts, lines) : keyLine;
  return { first, keyLine, last };
}

// Spans for every item of a block map; floor for the first item is `floor`.
function itemSpans(map, starts, lines, floor) {
  const out = [];
  let prev = floor;
  for (const pair of map.items) {
    const span = pairSpan(pair, starts, lines, prev);
    out.push({ pair, key: String(pair.key.value), ...span });
    prev = span.last;
  }
  return out;
}

// Re-indent template lines from one indentation style to the consumer's.
// `from.base`/`to.base` are the columns of the level being moved; `from.unit`
// and `to.unit` are each file's per-level step, so deeper lines scale too.
function reindent(textLines, from, to) {
  return textLines.map((line) => {
    if (isBlank(line)) return "";
    const rel = indentOf(line) - from.base;
    if (rel < 0) throw new Manual("template lines sit left of their own block");
    const levels = from.unit > 0 && rel % from.unit === 0 ? rel / from.unit : null;
    const col = to.base + (levels === null ? rel : levels * to.unit);
    return " ".repeat(col) + line.trimStart();
  });
}

function jobsOf(doc, label) {
  const jobs = doc.get("jobs", true);
  if (!YAML.isMap(jobs)) throw new Manual(`${label} has no block \`jobs:\` map`);
  return jobs;
}

// Column of a job's items and the file's per-level unit, read from the source.
function style(jobs, jobPair, starts, lines) {
  const job = jobPair.value;
  const jobCol = indentOf(lines[lineOf(starts, jobPair.key.range[0])]);
  const itemCol = job.items.length
    ? indentOf(lines[lineOf(starts, job.items[0].key.range[0])])
    : jobCol + 2;
  return { itemCol, unit: itemCol - jobCol };
}

function diffKeys(canon, cons) {
  const c = canon && typeof canon === "object" ? canon : {};
  const s = cons && typeof cons === "object" ? cons : {};
  const added = Object.keys(c).filter((k) => !(k in s));
  const removed = Object.keys(s).filter((k) => !(k in c));
  const changed = Object.keys(c).filter((k) => k in s && stable(c[k]) !== stable(s[k]));
  const parts = [];
  if (added.length) parts.push(`added ${added.join(", ")}`);
  if (removed.length) parts.push(`removed ${removed.join(", ")}`);
  if (changed.length) parts.push(`changed ${changed.join(", ")}`);
  if (!parts.length) parts.push(`replaced ${JSON.stringify(cons)} with the template's map`);
  return parts.join("; ");
}

// One job's splice. Returns the new source text.
function spliceJob(src, canonSrc, jn) {
  const doc = parse(src);
  const cdoc = parse(canonSrc);
  const starts = lineStarts(src);
  const lines = src.split("\n");
  const cstarts = lineStarts(canonSrc);
  const clines = canonSrc.split("\n");

  const jobs = jobsOf(doc, "the caller");
  const cjobs = jobsOf(cdoc, "the template");
  const jobPair = jobs.items.find((p) => String(p.key.value) === jn);
  const cjobPair = cjobs.items.find((p) => String(p.key.value) === jn);
  if (!YAML.isMap(jobPair.value) || jobPair.value.flow) {
    throw new Manual(`job ${jn} is not a block map`);
  }
  if (!YAML.isMap(cjobPair.value) || cjobPair.value.flow) {
    throw new Manual(`the template's job ${jn} is not a block map`);
  }
  const job = jobPair.value;
  const cjob = cjobPair.value;
  const jobLine = lineOf(starts, jobPair.key.range[0]);
  const cjobLine = lineOf(cstarts, cjobPair.key.range[0]);
  const s = style(jobs, jobPair, starts, lines);
  const cs = style(cjobs, cjobPair, cstarts, clines);

  const spans = itemSpans(job, starts, lines, jobLine);
  const cspans = itemSpans(cjob, cstarts, clines, cjobLine);
  const sp = spans.find((x) => x.key === "secrets");
  const cp = cspans.find((x) => x.key === "secrets");
  const jobLevel = (textLines) =>
    reindent(textLines, { base: cs.itemCol, unit: cs.unit }, { base: s.itemCol, unit: s.unit });

  const replace = (first, last, repl) => [...lines.slice(0, first), ...repl, ...lines.slice(last + 1)];

  // Template dropped the map: remove it with the comments directly above it.
  if (sp && !cp) return replace(sp.first, sp.last, []).join("\n");

  // Consumer lacks the map: insert the template's (with its comments) after the
  // nearest key that precedes `secrets` in the template and exists here.
  if (!sp && cp) {
    const block = jobLevel(clines.slice(cp.first, cp.last + 1));
    const before = cspans.slice(0, cspans.indexOf(cp)).reverse();
    const anchor = before.map((c) => spans.find((x) => x.key === c.key)).find(Boolean);
    let at;
    if (anchor) at = anchor.last + 1;
    else if (cspans.indexOf(cp) === 0) at = spans.length ? spans[0].first : jobLine + 1;
    else at = spans.length ? spans[spans.length - 1].last + 1 : jobLine + 1;
    return [...lines.slice(0, at), ...block, ...lines.slice(at)].join("\n");
  }

  const val = sp.pair.value;
  const cval = cp.pair.value;
  if (val && (val.anchor || YAML.isAlias(val))) {
    throw new Manual(`job ${jn}'s secrets map is anchored or aliased`);
  }

  // Both block maps: merge key by key, in the template's order. A key whose
  // value already matches keeps the consumer's own lines and comments.
  if (YAML.isMap(val) && !val.flow && val.items.length && YAML.isMap(cval) && !cval.flow) {
    const items = itemSpans(val, starts, lines, sp.keyLine);
    const citems = itemSpans(cval, cstarts, clines, cp.keyLine);
    const col = indentOf(lines[items[0].keyLine]);
    const ccol = citems.length ? indentOf(clines[citems[0].keyLine]) : cs.itemCol + cs.unit;
    const body = [];
    for (const c of citems) {
      const mine = items.find((x) => x.key === c.key);
      const same =
        mine && stable(mine.pair.value?.toJSON?.() ?? null) === stable(c.pair.value?.toJSON?.() ?? null);
      if (same) body.push(...lines.slice(mine.first, mine.last + 1));
      else {
        body.push(
          ...reindent(clines.slice(c.first, c.last + 1), { base: ccol, unit: cs.unit }, { base: col, unit: s.unit }),
        );
      }
    }
    if (!body.length) return replace(sp.first, sp.last, []).join("\n");
    return replace(items[0].first, items[items.length - 1].last, body).join("\n");
  }

  // Anything else (`secrets: inherit`, a flow map, an empty map): swap the
  // whole pair for the template's, keeping the consumer's comments above it.
  return replace(sp.keyLine, sp.last, jobLevel(clines.slice(cp.keyLine, cp.last + 1))).join("\n");
}

// Everything except each job's `secrets` must be unchanged by a splice.
function withoutSecrets(src) {
  const obj = YAML.parse(src) || {};
  for (const job of Object.values(obj.jobs || {})) if (job && typeof job === "object") delete job.secrets;
  return stable(obj);
}

function reconcileFile(name, canonSrc, src) {
  const canonShape = structuralShape(canonSrc, name);
  const report = [];
  let text = src;
  for (const jn of Object.keys(canonShape.jobs)) {
    const shape = structuralShape(text, name);
    if (!shape.jobs[jn]) continue;
    const want = canonShape.jobs[jn].secrets;
    const have = shape.jobs[jn].secrets;
    if (stable(want) === stable(have)) continue;
    const next = spliceJob(text, canonSrc, jn);
    let verified;
    try {
      parse(next);
      verified = structuralShape(next, name).jobs[jn]?.secrets;
    } catch {
      throw new Manual(`job ${jn}: the spliced file no longer parses`);
    }
    if (stable(verified) !== stable(want)) throw new Manual(`job ${jn}: the splice did not verify`);
    if (withoutSecrets(next) !== withoutSecrets(text)) {
      throw new Manual(`job ${jn}: the splice changed more than the secrets map`);
    }
    report.push(`job ${jn}: ${diffKeys(want, have)}`);
    text = next;
  }
  return { text, report };
}

function main() {
  const canonDir = argOf("canonical-dir");
  const wfDir = argOf("workflows-dir");
  if (!canonDir || !wfDir) {
    console.log("MANUAL --canonical-dir and --workflows-dir are both required");
    return 3;
  }
  let checked = 0;
  let updated = 0;
  let manual = 0;
  const names = fs.readdirSync(canonDir).filter((n) => /\.ya?ml$/.test(n)).sort();
  for (const name of names) {
    const dest = path.join(wfDir, name);
    if (!fs.existsSync(dest)) continue;
    checked++;
    const src = fs.readFileSync(dest, "utf8");
    try {
      const { text, report } = reconcileFile(name, fs.readFileSync(path.join(canonDir, name), "utf8"), src);
      if (text !== src) {
        fs.writeFileSync(dest, text);
        updated++;
        for (const line of report) console.log(`UPDATED ${name} ${line}`);
      }
    } catch (err) {
      if (!(err instanceof Manual) && !(err instanceof YAML.YAMLError)) throw err;
      manual++;
      // Only what went wrong — never a parser's dump of the document.
      console.log(`MANUAL ${name}: ${err instanceof Manual ? err.message : "does not parse"} — left unchanged`);
    }
  }
  console.log(`SUMMARY checked ${checked} caller(s): ${updated} updated, ${manual} need a manual fix`);
  return manual ? 3 : 0;
}

if (require.main === module) process.exit(main());

module.exports = { reconcileFile };
