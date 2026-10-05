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
 *   - node / npm / npx needs an earlier actions/setup-node step in the job
 *     (the image's default Node goes 22 -> 24 on 26.04). A composite action
 *     cannot choose its caller's runtime, so a composite that runs node without
 *     its own setup-node step is exempt itself and instead requires every job
 *     that calls it (`./.github/actions/<x>` or `./.cms-platform/.github/actions/<x>`)
 *     to have a setup-node step before the call
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
  // Optional `NAME=value ` prefixes (value bare, "double" or 'single' quoted,
  // possibly continued with a backslash-newline) sit between the separator and
  // the command word: `| RG_LOOP="$RG_LOOP" node -e ...`.
  const assign = `(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\\s"'\`;&|()]*)(?:\\s|\\\\\\n)+)*`;
  const re = new RegExp(`(?:^|[;&|(\`]|\\$\\()\\s*${assign}(${names})(?=\\s|$)`, "m");
  const m = code.match(re);
  return m ? m[1] : null;
}

// `./.github/actions/<x>` or `./.cms-platform/.github/actions/<x>` -> "<x>".
function localActionName(uses) {
  const m = typeof uses === "string" && uses.match(/^\.\/(?:\.cms-platform\/)?\.github\/actions\/([^/@\s]+)/);
  return m ? m[1] : null;
}

const NODE_NAMES = "node|npm|npx";
const NODE_SETUP = (s) => typeof s.uses === "string" && /^actions\/setup-node@/.test(s.uses);

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
    names: NODE_NAMES,
    setup: NODE_SETUP,
    need: "an earlier `actions/setup-node` step",
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
    lists.push({ name: "(composite action)", steps: root.runs.steps, composite: true });
  }
  return lists;
}

function findUnpinnedRuntimes(text, nodeActions = new Set()) {
  const offenders = [];
  for (const { name, steps, composite } of stepLists(text)) {
    steps.forEach((step, i) => {
      if (!step) return;
      const before = steps.slice(0, i);
      const callee = localActionName(step.uses);
      if (callee && nodeActions.has(callee) && !before.some(NODE_SETUP)) {
        offenders.push({
          job: name,
          step: step.name || `step ${i}`,
          word: `uses ${callee}`,
          need: `an earlier \`actions/setup-node\` step (the \`${callee}\` action runs node)`,
        });
      }
      if (typeof step.run !== "string") return;
      for (const rt of RUNTIMES) {
        if (composite && rt.setup === NODE_SETUP) continue;
        const word = commandWord(step.run, rt.names);
        if (word && !before.some(rt.setup)) {
          offenders.push({ job: name, step: step.name || `step ${i}`, word, need: rt.need });
        }
      }
    });
  }
  return offenders;
}

// Local composite actions that run node and do not set it up themselves.
function actionsNeedingNode(actionFiles) {
  const needing = new Set();
  for (const f of actionFiles) {
    const root = parseYaml(fs.readFileSync(f, "utf8")) || {};
    const steps = (root.runs && Array.isArray(root.runs.steps) && root.runs.steps) || [];
    const bare = steps.some(
      (s, i) =>
        s &&
        typeof s.run === "string" &&
        commandWord(s.run, NODE_NAMES) &&
        !steps.slice(0, i).some(NODE_SETUP),
    );
    if (bare) needing.add(path.basename(path.dirname(f)));
  }
  return needing;
}

const describeOffenders = (offs) =>
  offs.map((o) => `  job ${o.job}, step "${o.step}": \`${o.word}\` needs ${o.need}`).join("\n");

const actionFiles = fs.existsSync(ACTIONS_DIR)
  ? fs
      .readdirSync(ACTIONS_DIR)
      .map((d) => path.join(ACTIONS_DIR, d, "action.yml"))
      .filter((f) => fs.existsSync(f))
  : [];
const nodeActions = actionsNeedingNode(actionFiles);
const files = [...listWorkflows(), ...actionFiles];

for (const file of files) {
  const label = path.relative(path.resolve(__dirname, ".."), file);
  test(`${label} :: runtimes are pinned, not inherited from the runner image`, () => {
    const offenders = findUnpinnedRuntimes(fs.readFileSync(file, "utf8"), nodeActions);
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
      - run: npm ci
      - run: |
          echo "$(node -p 1)"
      - run: npx playwright test
`;
  expect(findUnpinnedRuntimes(unpinned).map((o) => o.word)).toEqual([
    "python3",
    "ruby",
    "actionlint",
    "npm",
    "node",
    "npx",
  ]);

  const pinned = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97
      - uses: ruby/setup-ruby@e8944e80fb94b20106697132f8c20c665fab29e9
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
        with:
          node-version: "20"
      - run: npm ci && node -p 1 && npx playwright --version
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
      - run: node script.js
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
`;
  expect(findUnpinnedRuntimes(late).map((o) => o.word)).toEqual(["python3", "node"]);
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

test("the command word is found after env assignments, whatever the separator", () => {
  const word = (run, names = "node|npm|npx") => commandWord(run, names);
  expect(word("echo 1 | FOO=1 node -e 'x'")).toBe("node");
  expect(word('printf x | RG_LOOP="$RG_LOOP" node -e "y"')).toBe("node");
  expect(word('A=1 B="x y" npx playwright test')).toBe("npx");
  expect(word("echo \"$(X=1 node -p 1)\"")).toBe("node");
  expect(word("true && FOO=1 npm ci")).toBe("npm");
  expect(word("true; FOO='a b' node x.js")).toBe("node");
  expect(word("FOO=1 \\\n  node x.js")).toBe("node");
  // A word that merely follows an argument, or is part of another word, is not a call.
  expect(word("echo FOO=1 node")).toBeNull();
  expect(word("echo node_modules; ls nodejs")).toBeNull();
  expect(word("FOO=node bash x.sh")).toBeNull();
});

test("a composite that runs node is exempt itself and obliges its callers", () => {
  const composite = `
runs:
  using: composite
  steps:
    - shell: bash
      run: node script.js
`;
  expect(findUnpinnedRuntimes(composite)).toEqual([]);

  const caller = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.cms-platform/.github/actions/needs-node
      - uses: ./.github/actions/other
`;
  expect(findUnpinnedRuntimes(caller, new Set(["needs-node"])).map((o) => o.word)).toEqual([
    "uses needs-node",
  ]);

  const pinnedCaller = `
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020
      - uses: ./.github/actions/needs-node
`;
  expect(findUnpinnedRuntimes(pinnedCaller, new Set(["needs-node"]))).toEqual([]);
});

test("the node-needing composites in this repo are discovered", () => {
  // Guards the discovery itself: if it found nothing, the caller check above
  // would pass vacuously.
  expect([...nodeActions].sort()).toEqual([
    "await-prod-deploy",
    "cms-recursion-gate",
    "install-playwright-browsers",
    "post-failure-comment",
  ]);
});
