#!/usr/bin/env node
// Platform-owned ANTI-SKEW guard (issue #29).
//
// WHAT
// A consuming repo references the cms-platform version in many places that can
// drift out of lockstep because Dependabot + platform-bump land bumps PIECEMEAL:
//
//   - .github/workflows/**/*.yml — reusable-workflow callers
//       `uses: <owner>/<repo>/.github/workflows/<name>.yml@<ref>`     (the <ref>)
//     and SHA-pinned composite actions
//       `uses: <owner>/<repo>/.github/actions/<name>@<sha>  # vX.Y.Z`  (the COMMENT)
//   - Gemfile      — `gem "cms-platform-theme", …, tag: "vX.Y.Z"`
//   - Gemfile.lock — the cms-platform GIT source block's `tag:`
//   - platform.lock — `platform_ref:` (the SOURCE OF TRUTH)
//
// Observed live: adamdaniel.ai pinned @v0.1.0 loop/deploy callers, gem @v0.1.5,
// and others @v0.1.3/@v0.1.6 at once. Skew is a latent behaviour-bug source (a
// v0.1.0 reusable running against a v0.1.5 gem) and breaks the "platform moves
// in lockstep" model.
//
// THIS GUARD derives the CANONICAL version from platform.lock `platform_ref`
// and asserts EVERY platform-version reference equals it. It aggregates ALL
// violations (does not stop at the first), prints a precise per-file report
// (file + found value + expected platform_ref), and exits non-zero iff any
// reference disagrees. When all agree it prints a concise OK summary and exits 0.
//
// HOW the workflow refs are read
//   - The reusable/composite `uses:` STRINGS are read with a real YAML parser
//     (`yaml`, eemeli) so anchors/aliases resolve and GitHub's evaluated value
//     is what we check — NOT a regex over raw text.
//   - EXCEPTION: a SHA-pinned composite action's required version GATE lives in
//     the trailing `# vX.Y.Z` COMMENT, and the YAML parser DROPS comments. So
//     for composite refs we additionally do a LINE-AWARE pass to read the
//     comment on the same source line as the `uses:` (documented, justified
//     exception — same rationale as scripts/sync-action-pin-comments.sh, which
//     also must read trailing `uses:` comments line-aware). The comment, not the
//     SHA, is the gate (resolving SHA→tag would need network/git; optional).
//
// USAGE
//   node scripts/check-platform-pin-consistency.js [--root DIR]
//        [--owner OWNER] [--repo REPO] [--lock platform.lock]
//   env equivalents: PIN_CHECK_ROOT, PLATFORM_OWNER, PLATFORM_REPO, PLATFORM_LOCK
//   Defaults: root=cwd, owner/repo derived from platform.lock `platform_repo`
//             (fallback Adam-S-Daniel/cms-platform), lock=platform.lock.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ── Resolve the `yaml` parser robustly ───────────────────────────────────────
// This script ships in the platform and is run by consumers from a
// `.cms-platform/` checkout, so `yaml` may live in a sibling node_modules
// (the repo's e2e/) rather than next to the script. Try the standard
// resolution, then a few known locations, before failing with guidance.
function loadYaml() {
  const candidates = [
    undefined, // standard node resolution (script's own node_modules chain)
    path.resolve(__dirname, "..", "e2e", "node_modules"),
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(process.cwd(), "e2e", "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ];
  for (const base of candidates) {
    try {
      const resolved = base
        ? require.resolve("yaml", { paths: [base] })
        : require.resolve("yaml");
      return require(resolved);
    } catch {
      /* try next */
    }
  }
  throw new Error(
    "Cannot resolve the `yaml` parser. Install it (e.g. `npm install yaml` " +
      "or run `cd e2e && npm ci`) before running this guard.",
  );
}
const YAML = loadYaml();

// ── CLI / env args ────────────────────────────────────────────────────────────
function argOf(name, envName, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return def;
}

const ROOT = path.resolve(argOf("root", "PIN_CHECK_ROOT", process.cwd()));
const LOCK_REL = argOf("lock", "PLATFORM_LOCK", "platform.lock");

// ── platform.lock → canonical version (source of truth) ──────────────────────
function die(msg) {
  process.stderr.write(`platform-pin-consistency: ${msg}\n`);
  process.exit(2);
}

function readPlatformLock() {
  const lockPath = path.join(ROOT, LOCK_REL);
  if (!fs.existsSync(lockPath)) {
    die(
      `${LOCK_REL} not found at ${lockPath}. The canonical platform version is ` +
        `read from platform.lock 'platform_ref:' — a consuming repo must carry it.`,
    );
  }
  let doc;
  try {
    doc = YAML.parse(fs.readFileSync(lockPath, "utf8"));
  } catch (e) {
    die(`${LOCK_REL} is not parseable YAML: ${e.message}`);
  }
  if (!doc || typeof doc !== "object") {
    die(`${LOCK_REL} is empty or not a mapping; expected a 'platform_ref:' key.`);
  }
  const ref = doc.platform_ref;
  if (!ref || typeof ref !== "string" || !ref.trim()) {
    die(`${LOCK_REL} has no 'platform_ref:' value (the canonical version).`);
  }
  const repoSlug =
    typeof doc.platform_repo === "string" && doc.platform_repo.trim()
      ? doc.platform_repo.trim()
      : null;
  return { platformRef: ref.trim(), repoSlug };
}

const { platformRef, repoSlug: lockRepoSlug } = readPlatformLock();

// owner/repo: explicit flag/env > platform.lock platform_repo > default.
const DEFAULT_SLUG = "Adam-S-Daniel/cms-platform";
const slugFromLock = lockRepoSlug || DEFAULT_SLUG;
const owner = argOf("owner", "PLATFORM_OWNER", slugFromLock.split("/")[0]);
const repo = argOf("repo", "PLATFORM_REPO", slugFromLock.split("/")[1] || "cms-platform");
const SLUG = `${owner}/${repo}`;

// ── Collect violations ────────────────────────────────────────────────────────
// Each: { file (repo-relative), kind, found, expected, detail }
const violations = [];
// Count of references we actually checked (for the OK summary).
let checked = 0;

function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

function record(absFile, kind, found, detail) {
  checked += 1;
  if (found !== platformRef) {
    violations.push({ file: rel(absFile), kind, found, expected: platformRef, detail });
  }
}

// ── Workflows: parse every .github/workflows/**/*.yml ─────────────────────────
function listWorkflowFiles() {
  const dir = path.join(ROOT, ".github", "workflows");
  if (!fs.existsSync(dir)) return [];
  const out = [];
  (function walk(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.ya?ml$/i.test(ent.name)) out.push(p);
    }
  })(dir);
  return out.sort();
}

// A `uses:` string that targets THIS platform owner/repo. Returns a classified
// descriptor, or null if it isn't a cms-platform ref.
//   reusable: `<owner>/<repo>/.github/workflows/<name>.yml@<ref>`
//   composite:`<owner>/<repo>/.github/actions/<name>@<sha>`
function classifyUses(usesStr) {
  if (typeof usesStr !== "string") return null;
  const at = usesStr.lastIndexOf("@");
  if (at === -1) return null;
  const target = usesStr.slice(0, at);
  const ref = usesStr.slice(at + 1);
  const prefix = `${SLUG}/`;
  if (!target.startsWith(prefix)) return null;
  const subpath = target.slice(prefix.length);
  if (/^\.github\/workflows\/.+\.ya?ml$/i.test(subpath)) {
    return { type: "reusable", ref, subpath };
  }
  if (/^\.github\/actions\/.+$/i.test(subpath)) {
    return { type: "composite", ref, subpath };
  }
  // Some other path under the platform repo (e.g. a script ref) — ignore by
  // default; not part of the version-pin contract.
  return null;
}

// Collect every `uses:` scalar from the parsed YAML (anchors resolved). The
// parser drops comments, so we ALSO need the source LINE for composite refs.
// We gather { uses, line } via the Document API: visit Scalar nodes whose
// parent Pair key is `uses`, and compute the 1-based line of the node's start.
function usesNodesWithLines(text) {
  const doc = YAML.parseDocument(text);
  const out = [];
  YAML.visit(doc, {
    Pair(_key, pair) {
      const k = pair.key && pair.key.value;
      const v = pair.value;
      if (k === "uses" && v && typeof v.value === "string" && v.range) {
        const line = text.slice(0, v.range[0]).split("\n").length;
        out.push({ uses: v.value, line });
      }
    },
  });
  return { out, lines: text.split("\n") };
}

// LINE-AWARE read of the trailing `# …` comment on a given 1-based source line.
// JUSTIFIED EXCEPTION to the "parse with YAML, not regex" rule: a SHA-pinned
// composite action's REQUIRED version gate lives in the trailing comment, which
// the YAML parser discards. Same pattern as scripts/sync-action-pin-comments.sh
// (which also must read trailing `uses:` comments line-aware). We only read the
// comment text here — the structural `uses:` value itself came from the parser.
function trailingComment(lines, line1) {
  const lineStr = lines[line1 - 1] || "";
  const hash = lineStr.indexOf("#");
  if (hash === -1) return "";
  return lineStr.slice(hash + 1).trim();
}

// Extract a `vX.Y.Z` (or any `vN…`) token from a comment like `v0.1.0 (2026-05-29)`.
function versionFromComment(comment) {
  const m = comment.match(/\bv\d+(?:\.\d+){0,3}\b/);
  return m ? m[0] : null;
}

for (const wf of listWorkflowFiles()) {
  let text;
  try {
    text = fs.readFileSync(wf, "utf8");
  } catch (e) {
    violations.push({
      file: rel(wf),
      kind: "workflow-read",
      found: `unreadable (${e.message})`,
      expected: platformRef,
      detail: "could not read workflow file",
    });
    continue;
  }
  let nodes;
  try {
    nodes = usesNodesWithLines(text);
  } catch (e) {
    violations.push({
      file: rel(wf),
      kind: "workflow-parse",
      found: `unparseable YAML (${e.message})`,
      expected: platformRef,
      detail: "could not parse workflow YAML",
    });
    continue;
  }
  for (const { uses, line } of nodes.out) {
    const cls = classifyUses(uses);
    if (!cls) continue; // not a cms-platform ref → ignore
    if (cls.type === "reusable") {
      // The pinned ref IS the version: `…@<ref>` must equal platform_ref.
      record(wf, `reusable uses:@${cls.subpath}`, cls.ref, `uses: ${uses}`);
    } else {
      // Composite: SHA-pinned; the gate is the trailing `# vX.Y.Z` comment.
      const comment = trailingComment(nodes.lines, line);
      const ver = versionFromComment(comment);
      if (!ver) {
        violations.push({
          file: rel(wf),
          kind: `composite uses:@${cls.subpath}`,
          found: comment ? `# ${comment} (no vX.Y.Z token)` : "(no # vX.Y.Z comment)",
          expected: platformRef,
          detail: `uses: ${uses}`,
        });
        checked += 1;
        continue;
      }
      record(wf, `composite uses:@${cls.subpath} (# comment)`, ver, `uses: ${uses}`);
    }
  }
}

// ── Gemfile (optional — some consumers have none) ─────────────────────────────
// `gem "cms-platform-theme", …, tag: "vX.Y.Z"`. Bundler's DSL isn't YAML, so a
// line/token read is the right tool here (documented). We anchor on the
// cms-platform-theme gem line + the git source pointing at our slug, then read
// its `tag:`.
function checkGemfile() {
  const gf = path.join(ROOT, "Gemfile");
  if (!fs.existsSync(gf)) return; // gem-less consumer → not a violation
  const text = fs.readFileSync(gf, "utf8");
  // Find the gem line(s) referencing cms-platform-theme on the platform git source.
  // A gem block can wrap lines, so scan logical statements (collapse continuations
  // ending in a comma onto the next line).
  const lines = text.split("\n");
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    let stmt = lines[i];
    // Join Ruby line continuations (a `,` or `\` at EOL continues the statement).
    let j = i;
    while (/[,\\]\s*$/.test(stmt) && j + 1 < lines.length) {
      j += 1;
      stmt += " " + lines[j].trim();
    }
    if (/gem\s+['"]cms-platform-theme['"]/.test(stmt) && stmt.includes(SLUG)) {
      found = true;
      const m = stmt.match(/\btag:\s*['"]([^'"]+)['"]/);
      if (!m) {
        violations.push({
          file: "Gemfile",
          kind: 'gem "cms-platform-theme" tag:',
          found: "(no tag: pin)",
          expected: platformRef,
          detail: stmt.trim(),
        });
        checked += 1;
      } else {
        record(gf, 'gem "cms-platform-theme" tag:', m[1], stmt.trim());
      }
      i = j;
    }
  }
  return found;
}

// ── Gemfile.lock (optional) ──────────────────────────────────────────────────
// The cms-platform GIT source block:
//   GIT
//     remote: https://github.com/<owner>/<repo>
//     revision: <sha>
//     tag: vX.Y.Z
// Bundler lockfile is its own format, not YAML → a structured line read of the
// GIT block whose `remote:` matches our slug (documented; same justification).
function checkGemfileLock() {
  const lf = path.join(ROOT, "Gemfile.lock");
  if (!fs.existsSync(lf)) return;
  const text = fs.readFileSync(lf, "utf8");
  const lines = text.split("\n");
  // Walk top-level sections; a GIT section starts at column 0 with "GIT".
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "GIT") continue;
    // Collect this section's indented body until the next column-0 line.
    let remote = null;
    let tag = null;
    let tagLine = -1;
    let k = i + 1;
    for (; k < lines.length; k++) {
      const ln = lines[k];
      if (ln.length && !/^\s/.test(ln)) break; // next top-level section
      const rm = ln.match(/^\s*remote:\s*(\S+)\s*$/);
      if (rm) remote = rm[1];
      const tg = ln.match(/^\s*tag:\s*(\S+)\s*$/);
      if (tg) {
        tag = tg[1];
        tagLine = k;
      }
    }
    const matchesSlug =
      remote &&
      (remote === `https://github.com/${SLUG}` ||
        remote === `https://github.com/${SLUG}.git` ||
        remote.replace(/\.git$/, "").endsWith(`/${SLUG}`));
    if (matchesSlug) {
      if (tag === null) {
        violations.push({
          file: "Gemfile.lock",
          kind: "GIT source tag: (cms-platform)",
          found: "(no tag: in the cms-platform GIT block)",
          expected: platformRef,
          detail: `remote: ${remote}`,
        });
        checked += 1;
      } else {
        record(lf, "GIT source tag: (cms-platform)", tag, `remote: ${remote} (line ${tagLine + 1})`);
      }
    }
    i = k - 1;
  }
}

// ── Workflow-set parity (consumer must carry EXACTLY the platform-dictated set) ─
// Beyond keeping every platform-version REFERENCE in lockstep, the platform also
// dictates the consumer workflow SET via examples/site/.github/workflows/. A
// consumer's .github/workflows/*.yml basenames must EQUAL that canonical set at
// the pinned ref — no MISSING (a platform-dictated workflow absent) and no EXTRA
// (a non-dictated workflow lingering). The canonical set is read from the platform
// checkout the reusable places at .cms-platform/ (so it reflects platform_ref).
// Skipped with a notice when the canonical dir is absent (a local run without the
// platform checkout) so this stays a no-op off-CI while the pin checks still run.
function listYamlBasenames(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => e.name);
}

function resolveCanonicalDir() {
  return path.resolve(
    argOf(
      "canonical-workflows",
      "PIN_CANONICAL_WORKFLOWS",
      path.join(ROOT, ".cms-platform", "examples", "site", ".github", "workflows"),
    ),
  );
}

function checkWorkflowSetParity() {
  const canonicalDir = resolveCanonicalDir();
  if (!fs.existsSync(canonicalDir)) {
    process.stdout.write(
      "platform-pin-consistency: (workflow-set parity skipped — canonical set not found at " +
        `${rel(canonicalDir) || canonicalDir}; pass --canonical-workflows, or run via the ` +
        "platform-pin-consistency reusable which checks out examples/site).\n",
    );
    return;
  }
  const canonical = new Set(listYamlBasenames(canonicalDir));
  const consumer = new Set(listYamlBasenames(path.join(ROOT, ".github", "workflows")));
  checked += 1;
  for (const name of [...canonical].sort()) {
    if (!consumer.has(name)) {
      violations.push({
        file: `.github/workflows/${name}`,
        kind: "workflow-set: MISSING (platform-dictated)",
        found: "absent",
        expected: `present (canonical @${platformRef})`,
        detail: `copy the thin caller examples/site/.github/workflows/${name} from the platform`,
      });
    }
  }
  for (const name of [...consumer].sort()) {
    if (!canonical.has(name)) {
      violations.push({
        file: `.github/workflows/${name}`,
        kind: "workflow-set: EXTRA (not platform-dictated)",
        found: "present",
        expected: "absent (not in the canonical set)",
        detail:
          "remove it, or promote it to the platform's examples/site/.github/workflows/ so every consumer carries it",
      });
    }
  }
}

// Deterministic stringify (recursively key-sorted) so two structurally-equal
// objects compare equal regardless of source key order / formatting.
function stableStringify(v) {
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  if (v && typeof v === "object") {
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(v[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(v);
}

// The CALL INTERFACE of a thin caller — the part that is strictly
// template-dictated (how it INVOKES the reusable): top-level `permissions`, and
// per job its `uses` target (version-normalized), its `with` KEY-set, its
// `secrets` map, and its job-level `permissions`. We DELIBERATELY exclude `on:`
// triggers, `name`, `run-name`, `concurrency`, `defaults` and `with` VALUES:
// those are legitimately site-operational (e.g. adamdaniel TRIMS the host-loop's
// push `paths:` to dodge prod-loop co-arrival eviction #1892; `apex:` is a site
// value; schedules can differ). What remains is the contract with the reusable —
// a drift here means the reusable is called WRONG (the sweep startup_failure:
// the caller dropped the now-required `secrets: CMS_E2E_PAT:` map). Comments +
// formatting drop out via the YAML parse.
function structuralShape(text) {
  const YAML = loadYaml();
  const normalized = text.replace(/@v\d+\.\d+\.\d+/g, "@vREF").replace(/\b[0-9a-f]{40}\b/g, "SHA40");
  const obj = YAML.parse(normalized) || {};
  const jobs = obj.jobs || {};
  const shape = { permissions: obj.permissions || null, jobs: {} };
  for (const [jn, job] of Object.entries(jobs)) {
    const j = job || {};
    shape.jobs[jn] = {
      uses: j.uses || null,
      withKeys: Object.keys((j.with && typeof j.with === "object" && j.with) || {}).sort(),
      secrets: j.secrets || null,
      permissions: j.permissions || null,
    };
  }
  return shape;
}

// Human-readable facets that differ (so a DRIFT is actionable, not just "differs").
function shapeFacetDiff(canon, cons) {
  const out = [];
  if (stableStringify(canon.permissions) !== stableStringify(cons.permissions)) {
    out.push("top-level `permissions`");
  }
  const cj = Object.keys(canon.jobs || {});
  const sj = Object.keys(cons.jobs || {});
  if (stableStringify([...cj].sort()) !== stableStringify([...sj].sort())) {
    out.push(`job set (canonical [${cj}] vs consumer [${sj}])`);
  }
  for (const jn of cj) {
    const a = (canon.jobs && canon.jobs[jn]) || {};
    const b = (cons.jobs && cons.jobs[jn]) || {};
    if (stableStringify(a.uses) !== stableStringify(b.uses)) {
      out.push(`job \`${jn}\` uses: target (canonical ${JSON.stringify(a.uses)} vs ${JSON.stringify(b.uses)})`);
    }
    if (stableStringify(a.withKeys) !== stableStringify(b.withKeys)) {
      out.push(`job \`${jn}\` with: keys (canonical [${a.withKeys}] vs [${b.withKeys}])`);
    }
    if (stableStringify(a.secrets) !== stableStringify(b.secrets)) {
      out.push(
        `job \`${jn}\` secrets: map (canonical ${JSON.stringify(a.secrets)} vs ${JSON.stringify(b.secrets)})`,
      );
    }
    if (stableStringify(a.permissions) !== stableStringify(b.permissions)) out.push(`job \`${jn}\` permissions`);
  }
  return out;
}

// CONTENT parity (companion to the SET parity above). A consumer's thin caller
// must match the canonical examples/site template's CALL INTERFACE — same `uses`
// target, same `with` KEYS, same `secrets` map, same permissions — modulo
// version refs and site-specific `with` VALUES. The version-pin checks above
// only compare the `@ref`/`tag` STRINGS; they are blind to a caller whose BODY
// drifted — e.g. jodidaniel's sweep caller, which dropped the now-required
// `secrets: CMS_E2E_PAT:` map and `startup_failure`s the reusable. This catches
// that class (and any missing/extra `with` key, wrong `uses` target, drifted
// permissions) WITHOUT false-positiving on a legit site value, a stale comment,
// or a deliberately site-tuned `on:` trigger (excluded — see structuralShape).
function checkWorkflowContentParity() {
  const canonicalDir = resolveCanonicalDir();
  if (!fs.existsSync(canonicalDir)) return; // set-parity already emitted the skip notice
  const consumerDir = path.join(ROOT, ".github", "workflows");
  for (const name of listYamlBasenames(canonicalDir).sort()) {
    const consumerFile = path.join(consumerDir, name);
    if (!fs.existsSync(consumerFile)) continue; // MISSING — already flagged by set-parity
    checked += 1;
    let canon;
    let cons;
    try {
      canon = structuralShape(fs.readFileSync(path.join(canonicalDir, name), "utf8"));
      cons = structuralShape(fs.readFileSync(consumerFile, "utf8"));
    } catch (e) {
      violations.push({
        file: `.github/workflows/${name}`,
        kind: "workflow-content: UNPARSEABLE",
        found: String(e.message || e),
        expected: "valid YAML matching the canonical caller",
        detail: "the caller (or canonical) failed to parse",
      });
      continue;
    }
    if (stableStringify(canon) === stableStringify(cons)) continue;
    const facets = shapeFacetDiff(canon, cons);
    violations.push({
      file: `.github/workflows/${name}`,
      kind: "workflow-content: DRIFT (thin caller structurally differs from canonical examples/site)",
      found: `consumer differs in: ${facets.join("; ") || "(structure)"}`,
      expected: `match canonical examples/site/.github/workflows/${name}`,
      detail:
        `re-copy the thin caller's call interface from examples/site/ (keep your own @ref pins, ` +
        `site-specific with: VALUES, and any deliberately site-tuned on: triggers — those are ` +
        `normalized/masked/excluded before compare; this flags a CALL-INTERFACE drift: a changed ` +
        `uses target, a missing/extra with: key, a drifted secrets: map (the sweep ` +
        `startup_failure class), or changed permissions).`,
    });
  }
}

checkGemfile();
checkGemfileLock();
checkWorkflowSetParity();
checkWorkflowContentParity();

// ── Report ────────────────────────────────────────────────────────────────────
if (violations.length === 0) {
  process.stdout.write(
    `platform-pin-consistency: OK — all ${checked} platform-version reference(s) ` +
      `in ${rel(ROOT) || "."} agree on platform_ref ${platformRef} ` +
      `(canonical, from ${LOCK_REL}). Pins are consistent.\n`,
  );
  process.exit(0);
}

const isCI = !!process.env.GITHUB_ACTIONS;
process.stderr.write(
  `platform-pin-consistency: FAIL — ${violations.length} reference(s) disagree ` +
    `with the canonical platform_ref ${platformRef} (from ${LOCK_REL}).\n\n`,
);
for (const v of violations) {
  // GitHub annotation (file-scoped) when in Actions; always a human line too.
  if (isCI) {
    process.stderr.write(
      `::error file=${v.file}::${v.kind} pins '${v.found}' but platform.lock platform_ref is '${v.expected}'\n`,
    );
  }
  process.stderr.write(
    `  ${v.file}\n    ${v.kind}\n      found:    ${v.found}\n      expected: ${v.expected}\n`,
  );
  if (v.detail) process.stderr.write(`      detail:   ${v.detail}\n`);
}
process.stderr.write(
  `\nFix: bring every reference above to ${platformRef} (the platform.lock ` +
    `platform_ref). Bump the workflow @ref pins + composite # comments, the ` +
    `Gemfile/Gemfile.lock tag, all to a SINGLE release. ` +
    `(platform-bump bumps platform.lock + with: inputs; Dependabot bumps the ` +
    `uses:@ pins + gem — they can land out of step, which is what this guard catches.)\n`,
);
process.exit(1);
