// @lane: local — pure-fs lint of workflow and composite-action YAML; no browser, no network
/*
 * Regression test: a job that runs a language runtime, or the actionlint
 * binary, must pin the version it runs on instead of inheriting whatever the
 * `ubuntu-latest` image carries.
 *
 * `ubuntu-latest` rolls to Ubuntu 26.04 from 2026-10-19 to 2026-11-19
 * (actions/runner-images#14748): system python3 3.12 -> 3.14, ruby 3.2 -> 3.3,
 * shellcheck 0.9 -> 0.11. A step calling the system interpreter changes
 * behavior with the image and no PR; actionlint runs whatever `shellcheck` is
 * on PATH over every `run:` block, so the image decides what the REQUIRED
 * actionlint lane flags.
 *
 *   - python3 / pip needs an earlier actions/setup-python step in the job
 *   - ruby / gem / bundle needs an earlier ruby/setup-ruby step in the job
 *   - actionlint needs an earlier step that installs a checksummed shellcheck
 *
 * Steps are read from the parsed YAML (anchors resolved); only the command-word
 * detection inside a `run:` body is lexical, and it skips comment lines.
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { listWorkflows, parseYaml } = require("./workflow-yaml-utils");

const ACTIONS_DIR = path.resolve(__dirname, "..", ".github", "actions");

// A command word: at the start of a line or after a shell separator, `$(`, or
// a backtick. `python3 - <<'PYEOF'` and `NAME=x python3 ...` (continuation
// line) both land on a line-start or separator match.
function commandWord(script, names) {
  const code = script
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  const re = new RegExp(`(?:^|[;&|(\`]|\\$\\()\\s*(${names})(?=\\s|$)`, "m");
  const m = code.match(re);
  return m ? m[1] : null;
}

const RUNTIMES = [
  {
    names: "python3?|pip3?",
    setup: (s) => typeof s.uses === "string" && /^actions\/setup-python@/.test(s.uses),
    need: "an earlier `actions/setup-python` step",
  },
  {
    names: "ruby|gem|bundle",
    setup: (s) => typeof s.uses === "string" && /^ruby\/setup-ruby@/.test(s.uses),
    need: "an earlier `ruby/setup-ruby` step",
  },
  {
    names: "actionlint",
    setup: (s) =>
      typeof s.run === "string" && /shellcheck/.test(s.run) && /sha256sum\s+-c/.test(s.run),
    need: "an earlier step that installs a pinned shellcheck and verifies it with `sha256sum -c`",
  },
];

// Every step list in a document: each workflow job's, or a composite action's.
function stepLists(text) {
  const root = parseYaml(text) || {};
  const lists = [];
  for (const [name, job] of Object.entries(root.jobs || {})) {
    if (job && Array.isArray(job.steps)) lists.push({ name, steps: job.steps });
  }
  if (root.runs && Array.isArray(root.runs.steps)) {
    lists.push({ name: "(composite action)", steps: root.runs.steps });
  }
  return lists;
}

function findUnpinnedRuntimes(text) {
  const offenders = [];
  for (const { name, steps } of stepLists(text)) {
    steps.forEach((step, i) => {
      if (!step || typeof step.run !== "string") return;
      for (const rt of RUNTIMES) {
        const word = commandWord(step.run, rt.names);
        if (word && !steps.slice(0, i).some(rt.setup)) {
          offenders.push({ job: name, step: step.name || `step ${i}`, word, need: rt.need });
        }
      }
    });
  }
  return offenders;
}

const describeOffenders = (offs) =>
  offs.map((o) => `  job ${o.job}, step "${o.step}": \`${o.word}\` needs ${o.need}`).join("\n");

const files = [
  ...listWorkflows(),
  ...(fs.existsSync(ACTIONS_DIR)
    ? fs
        .readdirSync(ACTIONS_DIR)
        .map((d) => path.join(ACTIONS_DIR, d, "action.yml"))
        .filter((f) => fs.existsSync(f))
    : []),
];

for (const file of files) {
  const label = path.relative(path.resolve(__dirname, ".."), file);
  test(`${label} :: runtimes are pinned, not inherited from the runner image`, () => {
    const offenders = findUnpinnedRuntimes(fs.readFileSync(file, "utf8"));
    expect(
      offenders,
      `${label} runs a runtime the ubuntu-latest image supplies, which changes ` +
        `with the image (Ubuntu 26.04 from 2026-10-19, runner-images#14748).\n` +
        describeOffenders(offenders),
    ).toEqual([]);
  });
}

test("the detector flags an unpinned interpreter and accepts a pinned one", () => {
  const unpinned = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: python3 script.py
      - run: |
          set -e
          ruby -ryaml -e 'puts 1'
      - run: actionlint -color
`;
  expect(findUnpinnedRuntimes(unpinned).map((o) => o.word)).toEqual([
    "python3",
    "ruby",
    "actionlint",
  ]);

  const pinned = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
      - uses: ruby/setup-ruby@e8944e80fb94b20106697132f8c20c665fab29e9
      - run: |
          echo "$SUM  /tmp/shellcheck.tar.xz" | sha256sum -c -
          shellcheck --version
      - run: python3 -m pip install --user pyyaml
      - run: |
          # python3 in a comment is not a call
          NAME=x \\
          ruby -e 'puts 1'
      - run: actionlint -color
`;
  expect(findUnpinnedRuntimes(pinned)).toEqual([]);
});

test("the detector requires the setup step to come BEFORE the runtime call", () => {
  const late = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: python3 script.py
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
`;
  expect(findUnpinnedRuntimes(late).map((o) => o.word)).toEqual(["python3"]);
});

test("the detector reads a composite action's steps", () => {
  const composite = `
runs:
  using: composite
  steps:
    - shell: bash
      run: gem install foo
`;
  expect(findUnpinnedRuntimes(composite).map((o) => o.word)).toEqual(["gem"]);
});
