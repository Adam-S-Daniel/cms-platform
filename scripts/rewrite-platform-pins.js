#!/usr/bin/env node
// Move a consumer's cms-platform PINS from one release to the next — and
// nothing else (cms-platform#530).
//
// WHY THIS EXISTS. platform-bump.yml used to run, over every pin-bearing file,
//     perl -i -pe 's/\Q$ENV{CUR}\E/$ENV{LATEST}/g'
// on the theory that by the single-version invariant the current version string
// appears ONLY as a current pin. It does not: prose names versions too. The
// v0.1.124 bump (jodidaniel/jodidaniel.com#303) rewrote
//     # since v0.1.123 — the CMS_PLATFORM_PAT fallback is gone.
// to "since v0.1.124", and every later bump re-dates it again. A historical
// comment is evidence; a bump must never edit it.
//
// WHAT A PIN IS. Exactly what check-platform-pin-consistency.js reads — the
// definition this script must agree with, or the bump PR it produces fails:
//   - workflows (.github/workflows/**/*.y{a,}ml), via the YAML parser:
//       * a `uses:` value `<slug>/.github/workflows/<name>.yml@<ref>` (reusable)
//         or `<slug>/.github/actions/<name>@<ref>` (composite) — the `<ref>`;
//       * a `platform_ref:` whose value is a plain string with no `${{ }}`.
//   - platform.lock: the `platform_ref:` value (same YAML pass).
//   - Gemfile: the `tag:` of the `gem "cms-platform-theme"` statement that
//     names the platform slug.
//   - Gemfile.lock: the `tag:` of the GIT block whose `remote:` is the
//     platform; that block's `revision:` moves to the release's commit with it.
// Plus one shape the checker cannot see but scripts/stale-platform-refs.js
// (verify-consumer-pins.sh's step 2) does: a COMMENTED-OUT pin — a YAML comment
// whose whole body is itself YAML holding one of the two workflow shapes above.
// examples/site ships one (deploy-production.yml's opt-in
// `# platform_ref: vX.Y.Z`, "Uncomment BOTH lines together"), scaffold/
// copies it into every new site, and its own comment promises platform-bump
// moves it in lockstep. Left behind, the stale-ref scanner fails the bump and
// uncommenting it later pins an old tree. Prose never parses into that shape
// with the old ref as the exact value, so it stays untouched.
//
// Only a pin whose ref EQUALS --from moves. A pin already at some other ref is
// skew that pin-consistency reports; silently "healing" it here would hide it.
//
// READ WITH A PARSER, WRITE WITH A SPLICE, THEN RE-PARSE. YAML is located with
// the `yaml` package (never a line regex: a regex cannot tell a comment, a
// `run:` string or another repo's `uses:` from a pin), and the version token is
// replaced IN PLACE at the parser's source offsets, so every other byte of the
// file — formatting, quoting, comments — is untouched. Each rewritten file is
// re-parsed and must hold no pin still at --from and the same number of pins.
// Bundler's Gemfile/Gemfile.lock are not YAML; they are read with the same
// structured line read the checker uses (and for the same documented reason).
//
// ALL OR NOTHING. Every file is computed before any is written; one failure
// (unparseable YAML, a pin that cannot be spliced safely) writes nothing.
//
// Usage:
//   node scripts/rewrite-platform-pins.js --from vOLD --to vNEW
//        [--new-sha <40-hex>] [--slug OWNER/REPO] [--root DIR]
// Prints `REWROTE <file>: <n> pin(s)` per changed file and a closing SUMMARY.
// Exit codes: 0 done (including "nothing to move"), 1 a file could not be
// rewritten (nothing written), 2 bad usage.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

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

const DEFAULT_SLUG = "Adam-S-Daniel/cms-platform";
// A ref is spliced into YAML and Ruby source, so it is validated, never trusted:
// no quote, space, newline or `#` can reach a consumer's file through it.
const REF_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;

class RewriteError extends Error {}

// ── YAML: workflows and platform.lock ────────────────────────────────────────

// The checker's classifyUses(), reduced to "is this a platform pin, and where
// does its ref start inside the value".
function usesRefIndex(value, slug) {
  const at = value.lastIndexOf("@");
  if (at === -1) return -1;
  const target = value.slice(0, at);
  if (!target.startsWith(`${slug}/`)) return -1;
  const subpath = target.slice(slug.length + 1);
  if (/^\.github\/workflows\/.+\.ya?ml$/i.test(subpath) || /^\.github\/actions\/.+$/i.test(subpath)) {
    return at + 1;
  }
  return -1;
}

// Where a scalar's VALUE text sits in the source, or a RewriteError when the
// source spelling is not the value verbatim (an escape, a fold, a block scalar)
// — splicing into those could change more than the version.
function valueSpan(node, src) {
  const [start, end] = node.range;
  const raw = src.slice(start, end);
  let inner = raw;
  let innerStart = start;
  if (node.type === "QUOTE_SINGLE" || node.type === "QUOTE_DOUBLE") {
    inner = raw.slice(1, -1);
    innerStart = start + 1;
  } else if (node.type !== "PLAIN") {
    throw new RewriteError(`a pin written as a ${node.type} scalar cannot be spliced safely`);
  }
  if (inner !== node.value) {
    throw new RewriteError(`a pin's source text differs from its value (${JSON.stringify(raw)})`);
  }
  return innerStart;
}

// Every pin in one parsed YAML text, as { offset, ref } with `offset` relative
// to that text. Mirrors check-platform-pin-consistency.js's pinNodesWithLines().
function yamlPins(text, slug) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) {
    throw new RewriteError(`does not parse as YAML: ${String(doc.errors[0].message).split("\n")[0]}`);
  }
  const pins = [];
  YAML.visit(doc, {
    Pair(_key, pair) {
      const k = pair.key && pair.key.value;
      const v = pair.value;
      if (!v || typeof v.value !== "string" || !v.range) return;
      if (k === "uses") {
        const i = usesRefIndex(v.value, slug);
        if (i === -1) return;
        pins.push({ node: v, valueOffset: i, ref: v.value.slice(i) });
      } else if (k === "platform_ref" && !v.value.includes("${{")) {
        const ref = v.value.trim();
        pins.push({ node: v, valueOffset: v.value.indexOf(ref), ref });
      }
    },
  });
  return pins.map((p) => ({ ref: p.ref, offset: () => valueSpan(p.node, text) + p.valueOffset }));
}

// Every comment token in a YAML source, from the parser's own CST (so a `#`
// inside a string or a `run:` block is never mistaken for one).
function yamlComments(src) {
  const out = [];
  (function walk(t) {
    if (Array.isArray(t)) return t.forEach(walk);
    if (!t || typeof t !== "object") return;
    if (t.type === "comment" && typeof t.source === "string" && typeof t.offset === "number") {
      out.push({ offset: t.offset, source: t.source });
    }
    for (const [k, v] of Object.entries(t)) if (k !== "source") walk(v);
  })([...new YAML.Parser().parse(src)]);
  return out;
}

// Commented-out pins: a comment whose body (after `#`) parses cleanly as YAML
// and holds a pin. Prose either fails to parse, parses to a non-pin, or names
// the version inside a longer value — none of which equals the ref exactly.
function dormantPins(src, slug) {
  const pins = [];
  for (const c of yamlComments(src)) {
    const body = c.source.slice(1);
    let found;
    try {
      found = yamlPins(body, slug);
    } catch {
      continue; // prose that is not YAML at all, or a pin we cannot splice: leave the comment alone
    }
    for (const p of found) {
      let rel;
      try {
        rel = p.offset();
      } catch {
        continue;
      }
      pins.push({ ref: p.ref, offset: () => c.offset + 1 + rel });
    }
  }
  return pins;
}

function allYamlPins(src, slug) {
  return [...yamlPins(src, slug), ...dormantPins(src, slug)];
}

// ── Bundler files: the checker's structured line reads ───────────────────────

function lineStarts(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") starts.push(i + 1);
  return starts;
}

// Gemfile: the `tag:` in the cms-platform-theme gem statement naming the slug.
// Statements join across `,`/`\` continuations, exactly as the checker joins them.
function gemfilePins(src, slug) {
  const lines = src.split("\n");
  const starts = lineStarts(src);
  const pins = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    let stmt = lines[i];
    while (/[,\\]\s*$/.test(stmt) && j + 1 < lines.length) {
      j += 1;
      stmt += ` ${lines[j].trim()}`;
    }
    if (/gem\s+['"]cms-platform-theme['"]/.test(stmt) && stmt.includes(slug)) {
      for (let k = i; k <= j; k++) {
        const m = /\btag:\s*(['"])([^'"]+)\1/.exec(lines[k]);
        if (!m) continue;
        const col = m.index + m[0].length - 1 - m[2].length;
        pins.push({ ref: m[2], offset: () => starts[k] + col });
        break;
      }
      i = j;
    }
  }
  return pins;
}

function isPlatformRemote(remote, slug) {
  return (
    remote === `https://github.com/${slug}` ||
    remote === `https://github.com/${slug}.git` ||
    remote.replace(/\.git$/, "").endsWith(`/${slug}`)
  );
}

// Gemfile.lock: the platform GIT block's `tag:` (a pin) and `revision:` (the
// commit that tag resolves to, which has to move with it).
function gemfileLockBlocks(src, slug) {
  const lines = src.split("\n");
  const starts = lineStarts(src);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "GIT") continue;
    let remote = null;
    let tag = null;
    let revision = null;
    let k = i + 1;
    for (; k < lines.length; k++) {
      const ln = lines[k];
      if (ln.length && !/^\s/.test(ln)) break;
      const rm = /^\s*remote:\s*(\S+)\s*$/.exec(ln);
      if (rm) remote = rm[1];
      const tg = /^(\s*tag:\s*)(\S+)\s*$/.exec(ln);
      if (tg) tag = { ref: tg[2], at: starts[k] + tg[1].length };
      const rv = /^(\s*revision:\s*)(\S+)\s*$/.exec(ln);
      if (rv) revision = { sha: rv[2], at: starts[k] + rv[1].length };
    }
    if (remote && isPlatformRemote(remote, slug)) blocks.push({ tag, revision });
    i = k - 1;
  }
  return blocks;
}

// ── Splicing ─────────────────────────────────────────────────────────────────

// Replace each [at, oldText] with newText, back to front so offsets hold.
function splice(src, edits) {
  let out = src;
  for (const e of [...edits].sort((a, b) => b.at - a.at)) {
    if (out.slice(e.at, e.at + e.from.length) !== e.from) {
      throw new RewriteError(`internal: expected ${JSON.stringify(e.from)} at offset ${e.at}`);
    }
    out = out.slice(0, e.at) + e.to + out.slice(e.at + e.from.length);
  }
  return out;
}

function pinEdits(pins, from, to) {
  return pins.filter((p) => p.ref === from).map((p) => ({ at: p.offset(), from, to }));
}

// One file's new text (or the same text when it holds no pin at --from).
function rewriteText(kind, src, opts) {
  const { from, to, newSha, slug } = opts;
  if (kind === "yaml") {
    const edits = pinEdits(allYamlPins(src, slug), from, to);
    if (!edits.length) return { text: src, count: 0 };
    const text = splice(src, edits);
    // Re-parse: the result must still be YAML, hold the same number of pins,
    // and hold none at the old ref.
    const before = allYamlPins(src, slug).length;
    const after = allYamlPins(text, slug);
    if (after.length !== before || after.some((p) => p.ref === from)) {
      throw new RewriteError("the rewritten file does not re-parse to the expected pins");
    }
    return { text, count: edits.length };
  }
  if (kind === "gemfile") {
    const edits = pinEdits(gemfilePins(src, slug), from, to);
    return { text: edits.length ? splice(src, edits) : src, count: edits.length };
  }
  // gemfile.lock
  const edits = [];
  let count = 0;
  for (const b of gemfileLockBlocks(src, slug)) {
    if (!b.tag || b.tag.ref !== from) continue;
    edits.push({ at: b.tag.at, from, to });
    count += 1;
    if (newSha && b.revision && b.revision.sha !== newSha) {
      edits.push({ at: b.revision.at, from: b.revision.sha, to: newSha });
    }
  }
  return { text: edits.length ? splice(src, edits) : src, count };
}

function listTargets(root) {
  const out = [];
  if (fs.existsSync(path.join(root, "platform.lock"))) out.push({ rel: "platform.lock", kind: "yaml" });
  if (fs.existsSync(path.join(root, "Gemfile"))) out.push({ rel: "Gemfile", kind: "gemfile" });
  if (fs.existsSync(path.join(root, "Gemfile.lock"))) out.push({ rel: "Gemfile.lock", kind: "gemfile.lock" });
  const wf = path.join(root, ".github", "workflows");
  const found = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && /\.ya?ml$/i.test(ent.name)) found.push(p);
    }
  })(wf);
  for (const p of found.sort()) {
    out.push({ rel: path.relative(root, p).split(path.sep).join("/"), kind: "yaml" });
  }
  return out;
}

// Compute every file, then write. Returns { changed: [{rel, count}], errors: [...] }.
function rewriteTree(opts) {
  const root = path.resolve(opts.root || ".");
  const slug = opts.slug || DEFAULT_SLUG;
  const results = [];
  const errors = [];
  for (const t of listTargets(root)) {
    const abs = path.join(root, t.rel);
    try {
      const src = fs.readFileSync(abs, "utf8");
      const r = rewriteText(t.kind, src, { ...opts, slug });
      if (r.text !== src) results.push({ abs, rel: t.rel, text: r.text, count: r.count });
    } catch (e) {
      errors.push(`${t.rel}: ${e.message}`);
    }
  }
  if (errors.length) return { changed: [], errors };
  for (const r of results) fs.writeFileSync(r.abs, r.text);
  return { changed: results.map(({ rel, count }) => ({ rel, count })), errors };
}

function cli(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!["--from", "--to", "--new-sha", "--slug", "--root"].includes(a) || i + 1 >= argv.length) {
      process.stderr.write(`rewrite-platform-pins: bad argument '${a}'\n`);
      return 2;
    }
    args[a.slice(2)] = argv[++i];
  }
  const { from, to } = args;
  const newSha = args["new-sha"] || "";
  if (!from || !to || !REF_RE.test(from) || !REF_RE.test(to)) {
    process.stderr.write(
      "rewrite-platform-pins: --from and --to are required release refs (letters, digits, '.', '_', '-')\n",
    );
    return 2;
  }
  if (newSha && !SHA_RE.test(newSha)) {
    process.stderr.write("rewrite-platform-pins: --new-sha must be a 40-character lowercase commit SHA\n");
    return 2;
  }
  if (args.slug && !/^[\w.-]+\/[\w.-]+$/.test(args.slug)) {
    process.stderr.write("rewrite-platform-pins: --slug must be OWNER/REPO\n");
    return 2;
  }
  if (from === to) {
    process.stdout.write(`SUMMARY: --from equals --to (${from}); nothing to move\n`);
    return 0;
  }
  const { changed, errors } = rewriteTree({ from, to, newSha, slug: args.slug, root: args.root });
  if (errors.length) {
    for (const e of errors) process.stdout.write(`ERROR ${e}\n`);
    process.stdout.write(`SUMMARY: ${errors.length} file(s) could not be rewritten; NOTHING was written\n`);
    return 1;
  }
  for (const c of changed) process.stdout.write(`REWROTE ${c.rel}: ${c.count} pin(s)\n`);
  const total = changed.reduce((n, c) => n + c.count, 0);
  process.stdout.write(`SUMMARY: moved ${total} pin(s) in ${changed.length} file(s) from ${from} to ${to}\n`);
  return 0;
}

if (require.main === module) process.exit(cli(process.argv.slice(2)));

module.exports = { rewriteText, rewriteTree, cli };
