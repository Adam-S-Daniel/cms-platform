#!/usr/bin/env node
"use strict";
/*
 * check-pin-agreement — assert that a workflow which names a version TWICE
 * names the SAME version both times.
 *
 * ── THE DEFECT (#283) ─────────────────────────────────────────────────────
 * A caller of a cms-platform reusable carries the platform version twice:
 *
 *     jobs:
 *       audit:
 *         uses: Adam-S-Daniel/cms-platform/.github/workflows/<x>.yml@v0.1.87
 *         with:
 *           platform_ref: v0.1.87
 *
 * Dependabot's `github-actions` ecosystem moves the FIRST (it is a dependency
 * ref) and structurally CANNOT move the SECOND (it is a `with:` input value).
 * That is not speculative — one release produced fifteen piecemeal `uses:@`
 * bump PRs on one consumer, which is why the fleet's Dependabot `ignore` for
 * cms-platform refs exists at all.
 *
 * The resulting skew is worse than a crash. A half-bumped caller runs the NEW
 * reusable against the OLD script the stale `platform_ref` sparse-checks out,
 * and an argv-scanning `flag()` silently ignores a flag it does not know. So
 * the job goes GREEN, reports on the lanes the old script did know about, and
 * performs zero detection on the one the new workflow asked for — with nothing
 * anywhere saying so. Measured live: seven fleet repos sat a release behind on
 * exactly this pair while one of them accumulated fourteen unreported failing
 * default-branch push runs.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────
 * Any mapping that carries BOTH a `uses:` with an `@<ref>` AND a
 * `with.platform_ref` must have the two refs EQUAL. That is the whole check.
 *
 * It is deliberately IDENTITY-FREE: no repo slug, no canonical version, no
 * lockfile, no manifest. It compares a file against ITSELF. That is what makes
 * it adoptable by a fleet repo that has no `platform.lock`, no theme gem and no
 * pin-consistency gate — the repos where this skew is currently unguarded.
 * A job-level `uses:` is always a reusable WORKFLOW (steps, not jobs, name
 * actions), and a `platform_ref` input only means anything to a platform
 * reusable, so the pairing is unambiguous and needs no configuration to
 * disambiguate. Step-level mappings are walked the same way at no extra cost.
 *
 * ── IT PARSES ─────────────────────────────────────────────────────────────
 * GitHub enabled YAML anchors in workflows on 2025-09-18, so `&anchor` /
 * `*alias` are legal here and a `uses:` or a `platform_ref:` can be an ALIAS
 * whose value is written somewhere else entirely. A regex or a line scan reads
 * such a file as clean because it cannot see the value at all. So this walks
 * the parsed document, with `merge: true` so a `<<:` merge key resolves too —
 * otherwise `<<` survives as a literal own key and a job assembled that way
 * looks to every structural check like a job with no `uses:` and no `with:`.
 *
 * Findings are located by KEY PATH (`jobs.audit`, `jobs.x.steps[2]`), not by
 * line number, and that is a consequence of parsing rather than a shortcut: an
 * aliased value's line is not the line the reader has to edit, so a line number
 * there would point at the wrong place. The key path is exact either way.
 *
 * ── CLI ───────────────────────────────────────────────────────────────────
 *   node scripts/check-pin-agreement.js [--] [FILE_OR_DIR...]
 * With no argument it scans `.github/workflows` under the current directory.
 * Prints one `  FILE :: PATH: uses@REF != platform_ref REF` line per finding.
 * Exit codes are three-valued ON PURPOSE, because a caller has to tell "ran,
 * found skew" apart from "could not run":
 *   0  ran, every ref pair agrees (the pairs examined are reported)
 *   1  ran, skew found (each finding printed)
 *   2  could not run — bad usage, unreadable/unparseable file, or a scan that
 *      examined ZERO workflow files. A lint that silently examines nothing
 *      looks exactly like a lint that found nothing wrong, and this one is
 *      adopted by repos where nobody is watching the output closely.
 */

const fs = require("node:fs");
const path = require("node:path");

// Resolve the `yaml` parser from wherever this script has been dropped —
// the platform's own checkout, a `.cms-platform` sparse checkout with the
// package installed beside it, or an adopting repo's own node_modules.
// Mirrors scripts/audit-repo-settings.js's resolver; lazy, so requiring this
// file for its pure helpers never needs the package at all.
let YAML = null;
function loadYaml() {
  if (YAML) return YAML;
  const candidates = [
    undefined, // standard node resolution (this script's own module chain)
    path.resolve(__dirname, "..", "node_modules"),
    path.resolve(__dirname, "..", "e2e", "node_modules"),
    path.resolve(process.cwd(), "node_modules"),
    path.resolve(process.cwd(), "e2e", "node_modules"),
  ];
  for (const base of candidates) {
    try {
      YAML = require(base ? require.resolve("yaml", { paths: [base] }) : require.resolve("yaml"));
      return YAML;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    "Cannot resolve the `yaml` parser. This check PARSES workflows (a regex cannot see an " +
      "aliased value, and GitHub has allowed YAML anchors in workflows since 2025-09-18), so " +
      "the package is not optional. Install it next to this script — " +
      "`npm install --no-save yaml@2.9.0` in the directory this file's parent lives in — or " +
      "run the check through the platform's pin-agreement reusable workflow, which does that " +
      "for you.",
  );
}

// The `@<ref>` of a `uses:` value, or null when there is none. A local
// (`./path`) or container (`docker://…`) `uses:` has no ref to agree with, and
// the `@` in a `docker://` tag position is not a ref either — both return null
// and are simply not pairs.
function usesRef(uses) {
  if (typeof uses !== "string") return null;
  const value = uses.trim();
  if (value.startsWith("./") || value.startsWith(".\\") || value.startsWith("docker://")) {
    return null;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  return value.slice(at + 1);
}

/**
 * Every `uses:@<ref>` + `with.platform_ref` pair in one PARSED workflow.
 * Walks mappings recursively, so job-level and step-level pairs are found
 * alike. Values are already alias- and merge-key-resolved by the caller's
 * parse, which is the point.
 *
 * @param {unknown} doc a parsed workflow document
 * @returns {{path: string, uses: string, usesRef: string, platformRef: string}[]}
 */
function pinPairs(doc) {
  const out = [];
  (function walk(node, keyPath) {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${keyPath}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;

    const withBlock = node.with;
    const declared =
      withBlock && typeof withBlock === "object" && !Array.isArray(withBlock)
        ? withBlock.platform_ref
        : undefined;
    const ref = usesRef(node.uses);
    if (declared !== undefined && declared !== null && ref !== null) {
      out.push({
        path: keyPath || "<root>",
        uses: String(node.uses).trim(),
        usesRef: ref,
        platformRef: String(declared).trim(),
      });
    }

    for (const key of Object.keys(node)) {
      walk(node[key], keyPath ? `${keyPath}.${key}` : key);
    }
  })(doc, "");
  return out;
}

/**
 * Disagreeing pairs only — the findings.
 * @param {unknown} doc a parsed workflow document
 * @param {string} file label used in the finding
 */
function scanPinAgreement(doc, file) {
  return pinPairs(doc)
    .filter((p) => p.usesRef !== p.platformRef)
    .map((p) => ({ file, ...p }));
}

// Every workflow file named by `targets` (files taken as-is, directories
// expanded one level to their *.yml / *.yaml children). Sorted, so a report is
// stable across filesystems.
function resolveTargets(targets) {
  const files = [];
  for (const target of targets) {
    const stat = fs.statSync(target); // ENOENT here is exit 2, never a silent skip
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) {
        if (/\.ya?ml$/.test(name)) files.push(path.join(target, name));
      }
    } else {
      files.push(target);
    }
  }
  return files;
}

function main(argv) {
  const args = argv.filter((a) => a !== "--");
  const targets = args.length ? args : [path.join(process.cwd(), ".github", "workflows")];

  let files;
  try {
    files = resolveTargets(targets);
  } catch (err) {
    process.stderr.write(`check-pin-agreement: ${err.message}\n`);
    return 2;
  }

  if (files.length === 0) {
    process.stderr.write(
      `check-pin-agreement: examined ZERO workflow files (looked in: ${targets.join(", ")}). ` +
        `Refusing to report success on an empty scan — a check that silently examines nothing ` +
        `is indistinguishable from one that found nothing wrong.\n`,
    );
    return 2;
  }

  const yaml = (() => {
    try {
      return loadYaml();
    } catch (err) {
      process.stderr.write(`check-pin-agreement: ${err.message}\n`);
      return null;
    }
  })();
  if (!yaml) return 2;

  const findings = [];
  let pairs = 0;
  for (const file of files) {
    let doc;
    try {
      doc = yaml.parse(fs.readFileSync(file, "utf8"), { merge: true });
    } catch (err) {
      process.stderr.write(`check-pin-agreement: cannot parse ${file}: ${err.message}\n`);
      return 2;
    }
    pairs += pinPairs(doc).length;
    findings.push(...scanPinAgreement(doc, file));
  }

  if (findings.length) {
    process.stdout.write(
      `check-pin-agreement: ${findings.length} disagreeing ref pair(s) across ` +
        `${files.length} workflow file(s):\n`,
    );
    for (const f of findings) {
      process.stdout.write(
        `  ${f.file} :: ${f.path}: uses@${f.usesRef} != platform_ref ${f.platformRef}\n`,
      );
    }
    process.stdout.write(
      "\nThese two refs name the same thing and must move together. Dependabot can move the " +
        "`uses:@` half and cannot move the `platform_ref:` half, so a half-bump leaves the NEW " +
        "reusable running against the OLD script — which ignores flags it does not know and " +
        "reports GREEN having done nothing. Set both to the same ref in one commit.\n",
    );
    return 1;
  }

  process.stdout.write(
    `check-pin-agreement: OK — ${pairs} ref pair(s) agree across ${files.length} workflow ` +
      `file(s).\n`,
  );
  return 0;
}

module.exports = { usesRef, pinPairs, scanPinAgreement, resolveTargets, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
