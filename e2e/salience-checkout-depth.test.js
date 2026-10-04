// @lane: local — parses the platform's own workflow YAML; no network
//
// cms-platform#541: the salience jobs used to check out FULL history
// (`fetch-depth: 0`, 14-20 s each on adamdaniel.ai) to diff
// `origin/<base>...HEAD`. They now check out the PR merge commit and its two
// parents (`fetch-depth: 2`) and run e2e/ensure-merge-base.js, which deepens
// only until the merge base is proven (its behavior is locked by
// e2e/ensure-merge-base.test.js on real shallow repos). This lint locks the
// wiring: every job below
//   - checks the SITE out at depth 2 (never 0),
//   - fetches nothing itself (`git fetch` belongs to the helper, whose
//     fetches are the ones the proof covers),
//   - and, where the job diffs in a run step, runs the helper — with the
//     base bound from the step's `env:` — after the platform checkout that
//     provides it and before the diff.
// Failing CLOSED is a behavior, not a shape: the last describe EXECUTES every
// step that calls the helper with a `node` that fails, and requires the step
// to exit non-zero without writing an output that reads as "nothing salient".
// detect-changed-pages.js (the `generate` job) calls the helper itself.
const { test, expect } = require("./base");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const { findRunSteps, writeStubs, runStep } = require("./workflow-step-harness");

const JOBS = [
  { workflow: "visual-regression.yml", job: "detect", diffStep: "salience" },
  { workflow: "visual-regression.yml", job: "generate", diffStep: null },
  { workflow: "parity-preview.yml", job: "parity-probe", diffStep: "select" },
  { workflow: "preview-media.yml", job: "media-probe", diffStep: "salient" },
];

const isCheckout = (s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@");
const isSiteCheckout = (s) => isCheckout(s) && !(s.with && s.with.repository);
const isPlatformCheckout = (s) => isCheckout(s) && s.with && s.with.path === ".cms-platform";
// Shell words of one run script, backslash continuations joined.
const lines = (s) =>
  String(s.run || "")
    .replace(/\\\n/g, " ")
    .split("\n");
// Lexical shell words: remove quotes, keep variable spellings, and stop at an
// unquoted comment. Mark substitution boundaries so its commands can be read
// separately from the surrounding echo/printf arguments. No shell execution.
function words(line) {
  const tokens = [];
  let word = "";
  let quote = "";
  const substitutions = [];
  const flush = () => {
    if (word) tokens.push(word);
    word = "";
  };
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\\" && quote !== "'" && i + 1 < line.length) {
      word += line[++i];
    } else if (ch === "$" && line[i + 1] === "(" && quote !== "'") {
      // A command substitution executes even inside double quotes.
      flush();
      tokens.push("$(");
      substitutions.push({ end: ")", quote, depth: 0 });
      quote = "";
      i += 1;
    } else if (ch === "`" && quote !== "'") {
      // Backticks also execute inside double quotes.
      flush();
      if (substitutions.at(-1)?.end === "`") {
        tokens.push("`)");
        quote = substitutions.pop().quote;
      } else {
        tokens.push("`(");
        substitutions.push({ end: "`", quote });
        quote = "";
      }
    } else if (ch === "(" && !quote && substitutions.at(-1)?.end === ")") {
      flush();
      tokens.push(ch);
      substitutions.at(-1).depth += 1;
    } else if (ch === ")" && !quote && substitutions.at(-1)?.end === ")" && substitutions.at(-1).depth > 0) {
      flush();
      tokens.push(ch);
      substitutions.at(-1).depth -= 1;
    } else if (ch === ")" && !quote && substitutions.at(-1)?.end === ")") {
      flush();
      tokens.push("$)");
      quote = substitutions.pop().quote;
    } else if (quote) {
      if (ch === quote) quote = "";
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && !word) {
      break;
    } else if (/\s/.test(ch)) {
      flush();
    } else if ("()|;&".includes(ch)) {
      flush();
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  flush();
  return tokens;
}
// git's global options that take a SEPARATE argument; `--opt=value` spellings
// and the boolean flags (`-p`, `--no-pager`, ...) need no skipping.
const GIT_OPTIONS_WITH_ARG = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
  "--super-prefix",
  "--attr-source",
]);
// The git subcommands one line runs: scan every lexical word outside
// echo/printf arguments, including wrapper commands and shell control words.
// A substitution has its own command scope, then returns to its caller's.
function gitSubcommands(lineWords) {
  const subs = [];
  let command = true;
  let suppressed = false;
  const scopes = [];
  lineWords.forEach((word, i) => {
    if (["$(", "`("].includes(word)) {
      scopes.push(suppressed);
      command = true;
      suppressed = false;
      return;
    }
    if (["$)", "`)"].includes(word)) {
      suppressed = scopes.pop() ?? false;
      command = false;
      return;
    }
    if (["(", ")", "|", ";", "&"].includes(word)) {
      command = true;
      suppressed = false;
      return;
    }
    if (suppressed) return;
    if (command && (word === "{" || word === "}")) {
      command = true;
      return;
    }
    if (command && ["echo", "printf"].includes(word)) {
      suppressed = true;
      command = false;
      return;
    }
    if (command && (["if", "then", "elif", "else", "while", "until", "do", "!", "command", "env", "exec"].includes(word) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word))) return;
    command = false;
    if (word !== "git" && !word.endsWith("/git") && word !== "$GIT" && word !== "${GIT}") return;
    let j = i + 1;
    while (j < lineWords.length && lineWords[j].startsWith("-")) {
      j += GIT_OPTIONS_WITH_ARG.has(lineWords[j]) ? 2 : 1;
    }
    if (j < lineWords.length) subs.push(lineWords[j]);
  });
  return subs;
}
const helperLine = (s) => lines(s).find((l) => words(l).some((w) => w.endsWith("e2e/ensure-merge-base.js")));

for (const { workflow, job, diffStep } of JOBS) {
  test.describe(`${workflow} › ${job}`, () => {
    const steps = () => {
      const wf = parseYaml(readWorkflow(workflow));
      const j = wf.jobs && wf.jobs[job];
      expect(j, `${workflow} has a \`${job}\` job`).toBeTruthy();
      return j.steps || [];
    };

    test("checks the site out at fetch-depth 2, never full history", () => {
      const site = steps().filter(isSiteCheckout);
      expect(site, "exactly one site checkout").toHaveLength(1);
      expect(site[0].with && Number(site[0].with["fetch-depth"])).toBe(2);
      for (const s of steps().filter(isCheckout)) {
        expect(Number((s.with || {})["fetch-depth"] ?? 1), `${s.name}: fetch-depth`).not.toBe(0);
      }
    });

    test("no run step fetches history itself", () => {
      for (const s of steps()) {
        for (const l of lines(s)) {
          expect(
            gitSubcommands(words(l)),
            `${s.name}: \`${l.trim()}\` — fetch through ensure-merge-base.js`,
          ).not.toContain("fetch");
        }
      }
    });

    if (diffStep) {
      test("runs ensure-merge-base.js after the platform checkout and before the diff", () => {
        const all = steps();
        const platform = all.findIndex(isPlatformCheckout);
        const helper = all.findIndex((s) => helperLine(s));
        const diff = all.findIndex((s) => s.id === diffStep);
        expect(platform, "platform checkout into .cms-platform").toBeGreaterThan(-1);
        expect(helper, "a step runs e2e/ensure-merge-base.js").toBeGreaterThan(platform);
        expect(diff, `step id \`${diffStep}\``).toBeGreaterThanOrEqual(helper);

        const step = all[helper];
        const line = helperLine(step);
        const w = line.trim().split(/\s+/);
        const base = /^"\$([A-Z_]+)";?$/.exec(w[w.indexOf("--base") + 1] || "");
        expect(base, `--base takes a quoted env var in \`${line.trim()}\``).toBeTruthy();
        expect(Object.keys(step.env || {}), "the base is bound in the step's env:").toContain(base[1]);
      });
    }
  });
}

// Fail closed, proven by running the step. A step that swallows the helper's
// failure (`|| true`, a deleted `exit 1`) goes on to write `salient=false` /
// `count=0`, which a required check reads as "nothing salient changed" and
// passes without running: fail-open.
test.describe("every step that runs ensure-merge-base.js fails closed (behavioral)", () => {
  const steps = findRunSteps((run) => run.includes("e2e/ensure-merge-base.js"));
  const ids = steps.map((s) => `${s.workflow} › ${s.job} › ${s.step.name}`);

  test("the three known call sites are found", () => {
    for (const w of [
      "visual-regression.yml › detect",
      "parity-preview.yml › parity-probe",
      "preview-media.yml › media-probe",
    ]) {
      expect(
        ids.some((id) => id.startsWith(w)),
        `a step in ${w}`,
      ).toBe(true);
    }
  });

  let scratch;
  test.beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "emb-step-"));
  });
  test.afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  // `node` is a stub that logs its arguments and exits with `nodeStatus` for
  // the helper only (any other node call, such as the selector that follows
  // it, succeeds, so a swallowed helper failure cannot be masked by a later
  // failure); `git` and `tee` are harmless (a git that succeeds and prints
  // nothing, a tee that only copies stdin to stdout).
  function execute({ step }, nodeStatus) {
    const bin = writeStubs(path.join(scratch, "bin"), {
      node: `echo "$@" >> "$STUB_LOG"\ncase "$*" in *e2e/ensure-merge-base.js*) exit ${nodeStatus} ;; esac\nexit 0`,
      git: "exit 0",
      tee: "cat",
    });
    const work = path.join(scratch, "work");
    fs.mkdirSync(work, { recursive: true });
    const log = path.join(scratch, "node.log");
    const stepEnv = Object.fromEntries(Object.keys(step.env || {}).map((k) => [k, "main"]));
    const r = runStep(step, {
      cwd: work,
      scratch: path.join(scratch, "run"),
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, STUB_LOG: log },
      stepEnv,
    });
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    return { ...r, calls };
  }

  for (const found of steps) {
    const label = `${found.workflow} › ${found.job} › ${found.step.name}`;

    test(`${label}: a failing helper fails the step and writes no output`, () => {
      expect(found.step["continue-on-error"], "continue-on-error would swallow the failure").toBeFalsy();
      const r = execute(found, 1);
      expect(r.calls[0], "the helper is the first thing the step runs").toMatch(
        /e2e\/ensure-merge-base\.js --base main$/,
      );
      expect(r.status, `exit status; stderr: ${r.stderr}`).not.toBe(0);
      expect(r.output, "no output a later gate could read as `nothing salient`").toBe("");
    });

    test(`${label}: a succeeding helper lets the step through (the harness is not vacuous)`, () => {
      const r = execute(found, 0);
      expect(r.calls[0]).toMatch(/e2e\/ensure-merge-base\.js --base main$/);
      expect(r.status, `exit status; stderr: ${r.stderr}`).toBe(0);
    });
  }
});

// The lint above is only as good as its reading of `git ... fetch`; pin it on
// the spellings that hid a fetch behind global options.
test.describe("gitSubcommands (the no-direct-fetch lint's reader)", () => {
  const sub = (cmd) => gitSubcommands(words(cmd));
  test("quoted fetch is detected while comments and unrelated echo are ignored", () => {
    expect(sub('"git" fetch origin main')).toEqual(["fetch"]);
    for (const cmd of ["# git fetch origin main", 'echo "git fetch origin main"', "echo git fetch origin main"]) {
      expect(sub(cmd), cmd).toEqual([]);
    }
    expect(sub("git diff # git fetch origin main")).toEqual(["diff"]);
    expect(sub('files="$(git fetch origin main)"')).toEqual(["fetch"]);
    expect(sub("echo '$(git fetch origin main)'")).toEqual([]);
    for (const prefix of ["command", "env", "exec"]) {
      expect(sub(`${prefix} git fetch origin main`), prefix).toEqual(["fetch"]);
    }
  });
  for (const [cmd, expected] of [
    ["git fetch origin main", ["fetch"]],
    ["git -c k=v fetch origin main", ["fetch"]],
    ["git -c core.quotepath=off -c a=b fetch", ["fetch"]],
    ["git -C /tmp/work fetch", ["fetch"]],
    ["git --git-dir=.git --work-tree=. fetch", ["fetch"]],
    ["git --git-dir .git --no-pager fetch", ["fetch"]],
    ["echo x | git -c k=v fetch", ["fetch"]],
    ["git -c k=v diff --name-only", ["diff"]],
    ["git config --global --add safe.directory x", ["config"]],
    ["echo fetch", []],
    ['"git" fetch origin main', ["fetch"]],
    ["'git' fetch origin main", ["fetch"]],
    ["$GIT fetch origin main", ["fetch"]],
    ["${GIT} fetch origin main", ["fetch"]],
    ['"$GIT" -c k=v fetch origin main', ["fetch"]],
    ["/usr/bin/git fetch origin main", ["fetch"]],
    ['"/usr/bin/git" --git-dir .git fetch origin main', ["fetch"]],
    ['"git" --no-pager diff --name-only', ["diff"]],
    ['"$GIT" config --global user.name', ["config"]],
    ['files="$("git" fetch origin main)"', ["fetch"]],
    ['files="$("$GIT" -c k=v fetch origin main)"', ["fetch"]],
  ]) {
    test(`${cmd} -> ${JSON.stringify(expected)}`, () => {
      expect(sub(cmd)).toEqual(expected);
    });
  }
});

test.describe("gitSubcommands review round 2", () => {
  const sub = (cmd) => gitSubcommands(words(cmd));

  test("else branch runs a fetch after a separate command", () => {
    expect(sub("else git fetch o")).toEqual(["fetch"]);
    expect(sub("if false; then echo ok; else git fetch origin; fi")).toEqual(["fetch"]);
  });

  test("standalone braces leave Git visible without splitting variable braces", () => {
    expect(sub("{ git fetch o; }")).toEqual(["fetch"]);
    expect(sub("{ git fetch origin; }")).toEqual(["fetch"]);
    expect(sub("{ ${GIT} -c k=v fetch origin; }")).toEqual(["fetch"]);
    expect(sub("{ git fetch o; }; echo { git fetch ignored }")).toEqual(["fetch"]);
    expect(sub("{ git fetch o; }; printf '%s' { git fetch ignored }")).toEqual(["fetch"]);
  });

  test("while condition runs Git", () => {
    expect(sub("while git fetch o; do")).toEqual(["fetch"]);
    expect(sub("while git fetch origin; do echo waiting; done")).toEqual(["fetch"]);
  });

  test("timeout runs Git after its duration", () => {
    expect(sub("timeout 5 git fetch o")).toEqual(["fetch"]);
    expect(sub("timeout 5 git -C /tmp/work fetch origin")).toEqual(["fetch"]);
  });

  test("sudo runs a quoted Git command", () => {
    expect(sub("sudo git fetch o")).toEqual(["fetch"]);
    expect(sub('sudo "git" --git-dir .git fetch origin')).toEqual(["fetch"]);
  });

  test("xargs runs Git", () => {
    expect(sub("xargs git fetch")).toEqual(["fetch"]);
  });

  test("nohup runs Git through a path", () => {
    expect(sub("nohup git fetch o")).toEqual(["fetch"]);
    expect(sub("nohup /usr/bin/git fetch origin")).toEqual(["fetch"]);
  });

  test("env with a clean environment runs variable Git", () => {
    expect(sub("env -i git fetch o")).toEqual(["fetch"]);
    expect(sub("env -i $GIT fetch origin")).toEqual(["fetch"]);
  });

  test("env through a path runs Git", () => {
    expect(sub("/usr/bin/env git fetch")).toEqual(["fetch"]);
    expect(sub("/usr/bin/env git fetch origin")).toEqual(["fetch"]);
  });

  test("unquoted backticks run their own Git command", () => {
    expect(sub("value=`git fetch origin`")).toEqual(["fetch"]);
    expect(sub("echo `git fetch origin` git fetch ignored")).toEqual(["fetch"]);
  });

  test("double-quoted backticks run their own Git command", () => {
    expect(sub('value="`git fetch origin`"')).toEqual(["fetch"]);
    expect(sub('printf "%s git fetch ignored" "`git fetch origin`" git fetch ignored')).toEqual(["fetch"]);
  });

  test("echo arguments resume suppression after a dollar substitution", () => {
    expect(sub("echo $(git fetch origin) git fetch ignored")).toEqual(["fetch"]);
    expect(sub('echo "$(git fetch origin)" git fetch ignored')).toEqual(["fetch"]);
    expect(sub("echo '$(git fetch ignored)' $(git fetch origin) git fetch ignored # git fetch ignored")).toEqual(["fetch"]);
    expect(sub("echo $( (git diff); git fetch origin ) git fetch ignored")).toEqual(["diff", "fetch"]);
  });

  test("printf arguments resume suppression after a dollar substitution", () => {
    expect(sub("printf '%s git fetch ignored' $(git fetch origin) git fetch ignored")).toEqual(["fetch"]);
  });
});
