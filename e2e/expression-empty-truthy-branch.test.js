// @lane: local — pure-fs lint over every workflow in this repo; no browser, no network.
//
// THE BUG THIS EXISTS FOR (run 32280743541, cms-platform#280).
// `${{ a && b || c }}` is not a ternary. It is two operators, and GitHub Actions
// returns `c` whenever `b` is FALSY — and an empty string is falsy. So
//
//     ${{ inputs.push_scan && '' || '--no-push-scan' }}
//
// emitted `--no-push-scan` UNCONDITIONALLY, including on a dispatch that
// explicitly set `push_scan: true`. The default-branch push scan never ran, and
// the audit still printed "0 failing push run(s)" — from the static default, not
// from any API call. A silent no-op that reports HEALTHY is worse than a crash:
// nothing was red, so nothing drew attention, and only running it by hand and
// reading the resolved command line exposed it.
//
// The sibling line on the very next row was fine —
// `${{ inputs.dry_run && '--dry-run' || '' }}` — because its truthy branch is a
// NON-EMPTY string. That is the whole distinction, and it is invisible at a
// glance, which is why it needs a lint rather than a code review.
//
// Parsed with the YAML utility, never regex-scanned as text: a regex reads clean
// on structure it cannot see. We walk every string value in the document, so the
// check holds wherever the expression appears — `run:`, `with:`, `if:`, `env:`.
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, readWorkflow, parseYaml } = require("./workflow-yaml-utils");

// `${{ ... && '' || ... }}` and `${{ ... && "" || ... }}`, allowing any spacing.
const EMPTY_TRUTHY_BRANCH = /\$\{\{[^}]*?&&\s*(''|"")\s*\|\|[^}]*?\}\}/;

function strings(node, path, out) {
  if (typeof node === "string") out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((v, i) => strings(v, `${path}[${i}]`, out));
  else if (node && typeof node === "object")
    for (const [k, v] of Object.entries(node)) strings(v, path ? `${path}.${k}` : k, out);
  return out;
}

test.describe("no GitHub Actions expression puts an empty string on the truthy branch", () => {
  test("`${{ x && '' || y }}` never appears — it always returns y", () => {
    const files = listWorkflows();
    // Guard against a lint that silently checks nothing. `listWorkflows()` returns
    // ABSOLUTE paths while `readWorkflow()` takes a BASENAME and prepends the
    // workflows dir — passing the former made every read throw ENOENT, which a
    // blanket try/catch swallowed as "skip", so the first version of this spec
    // examined zero files and passed. Only the negative control caught it.
    expect(files.length, "listWorkflows() returned nothing — this lint would pass vacuously").toBeGreaterThan(0);

    const offenders = [];
    let examined = 0;
    for (const file of files) {
      // The READ is outside the try: a missing file is a bug in this spec, not a
      // malformed workflow, and must surface rather than be skipped.
      const raw = readWorkflow(path.basename(file));
      let doc;
      try {
        doc = parseYaml(raw);
      } catch {
        continue; // actionlint owns YAML validity; a parse error is its failure to report.
      }
      examined += 1;
      for (const [where, value] of strings(doc, "", [])) {
        if (EMPTY_TRUTHY_BRANCH.test(value)) offenders.push(`${path.basename(file)} → ${where}: ${value.trim()}`);
      }
    }
    expect(examined, "no workflow parsed — this lint would pass vacuously").toBeGreaterThan(0);
    expect(
      offenders,
      "An expression of the form `${{ x && '' || y }}` was found. That is not a " +
        "ternary: GitHub returns the `||` branch whenever the `&&` branch is falsy, " +
        "and an empty string IS falsy — so `y` is emitted unconditionally and the " +
        "flag you thought was conditional is always on. Put the NON-EMPTY value on " +
        "the truthy side (`x && '--flag' || ''`), or build the argument in shell " +
        "from an env var. Offenders:\n  " + offenders.join("\n  "),
    ).toEqual([]);
  });
});
