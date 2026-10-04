// @lane: local — real git repos in os.tmpdir(), file:// remotes, no network
//
// cms-platform#539: the visual-regression `detect` job and
// e2e/detect-changed-pages.js read `git diff --name-only`, whose default
// `core.quotepath` output wraps a non-ASCII (or quote / newline) path in
// double quotes with octal escapes — `"_layouts/caf\303\251.html"` — so the
// leading quote defeats every `^_layouts/` rule and a salient edit reads as
// non-salient. Both now read `git diff --name-only -z` and split on NUL.
//
// These tests drive REAL git so they fail if either reader goes back to the
// quoted form; a stubbed git would only restate the assumption.
//
// Also covered here: every changed-path diff the salience logic reads passes
// `--no-renames`. Rename detection reports only the DESTINATION of a move, so
// `_layouts/post.html` -> `uploads/post.html` read as a non-salient upload.
// preview-media.yml and select-specs.js had the same quoting defect as #539
// and are read NUL-delimited too.
const { test, expect } = require("./base");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createSandbox } = require("./git-fixture");
const { runDetect } = require("./detect-changed-pages");
const { getChangedFiles } = require("./select-specs");
const { findRunSteps, writeStubs, runStep } = require("./workflow-step-harness");

const SALIENT_CLI = path.join(__dirname, "visual-regression-salient.js");

// Pipe `input` into the salience CLI exactly as the workflow does.
function salientCli(input, args) {
  const r = spawnSync(process.execPath, [SALIENT_CLI, ...args], { input });
  expect(r.status, String(r.stderr)).toBe(0);
  return String(r.stdout);
}

test.describe("visual salience over `git diff -z` (cms-platform#539)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  // Each case changes one path (plus README.md, which is never salient), so
  // the classifier's verdict rests on that path alone.
  const CASES = [
    { file: "_layouts/café.html", salient: true },
    { file: "_includes/with space.html", salient: true },
    { file: '_includes/quote"d.html', salient: true },
    { file: "_includes/new\nline.html", salient: true },
    { file: "assets/css/thème.css", salient: true },
    { file: "_data/navigación.yml", salient: true },
    { file: "_posts/2026-01-01-crème brûlée.md", salient: false },
    { file: "assets/images/uploads/photo é.png", salient: false },
    { file: "assets/tools/outil/índice.html", salient: false },
  ];

  for (const { file, salient } of CASES) {
    test(`${JSON.stringify(file)} → salient=${salient}`, () => {
      sb = createSandbox("salience-z-");
      const repo = sb.initRepo("site");
      const base = sb.commit(repo, { "README.md": "base\n" }, "base");
      // README.md changes too and sorts first, so the case path is the
      // SECOND record: a reader that does not split on NUL sees one string
      // beginning "README.md" and matches nothing.
      const head = sb.commit(repo, { "README.md": "edited\n", [file]: "changed\n" }, "change");

      const nul = sb.git(repo, ["diff", "--name-only", "-z", base, head]);
      expect(nul, "git -z output carries the path verbatim").toBe(`README.md\0${file}\0`);
      expect(salientCli(nul, ["-z"])).toBe(String(salient));
    });
  }

  test("the quoted newline form is what misclassified a salient path", () => {
    // Pins the defect so the cases above are known to exercise it: without
    // `-z`, git quotes the name and the old newline reader calls a layout
    // change non-salient.
    sb = createSandbox("salience-quoted-");
    const repo = sb.initRepo("site");
    const base = sb.commit(repo, { "README.md": "base\n" }, "base");
    const head = sb.commit(repo, { "_layouts/café.html": "x\n" }, "change");
    const quoted = sb.git(repo, ["diff", "--name-only", base, head]);
    expect(quoted).toBe('"_layouts/caf\\303\\251.html"\n');
    expect(salientCli(quoted, [])).toBe("false");
    expect(salientCli(sb.git(repo, ["diff", "--name-only", "-z", base, head]), ["-z"])).toBe("true");
  });

  test("a content-only diff with odd names stays non-salient; one salient path flips it", () => {
    sb = createSandbox("salience-mixed-");
    const repo = sb.initRepo("site");
    const base = sb.commit(repo, { "README.md": "base\n" }, "base");
    const content = sb.commit(
      repo,
      {
        "_posts/2026-02-02-naïve.md": "post\n",
        "assets/images/uploads/a b.png": "img\n",
        "_data/tool_sources/outil é.yml": "src\n",
      },
      "content",
    );
    expect(salientCli(sb.git(repo, ["diff", "--name-only", "-z", base, content]), ["-z"])).toBe(
      "false",
    );
    const mixed = sb.commit(repo, { "_includes/pied de page.html": "x\n" }, "include");
    expect(salientCli(sb.git(repo, ["diff", "--name-only", "-z", base, mixed]), ["-z"])).toBe(
      "true",
    );
  });
});

test.describe("detect-changed-pages over real git (cms-platform#539)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  const PAGES = ["/", "/blog/", "/blog/crème brûlée/", "/blog/old/", "/blog/café/"];

  // origin/main holds two posts and an include; `pr` is the PR branch.
  function setup(prFiles) {
    sb = createSandbox("detect-z-");
    const src = sb.initRepo("src");
    sb.commit(
      src,
      {
        "_includes/en-tête.html": "<header></header>\n",
        "_posts/2026-01-01-old.md": "old\n",
        "_posts/2026-01-02-crème brûlée.md": "dessert\n",
      },
      "main",
    );
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    sb.commit(src, prFiles, "pr");
    const work = sb.fullClone(sb.publish(src));
    sb.git(work, ["checkout", "-q", "--detach", "origin/pr"]);
    return runDetect({ root: work, runDiscover: () => new Set(PAGES) });
  }

  test("a non-ASCII include edit fans out to every page; a new non-ASCII post is `new`", () => {
    const r = setup({
      "_includes/en-tête.html": "<header>changed</header>\n",
      "_posts/2026-02-01-café.md": "new post\n",
    });
    expect(r.new).toEqual(["/blog/café/"]);
    expect(r.changed.sort()).toEqual(["/", "/blog/", "/blog/crème brûlée/", "/blog/old/"].sort());
    expect(r.unchanged).toEqual([]);
  });

  test("an existing post whose name has spaces is `changed`, not `new`", () => {
    // fileExistsOnMain used to build `git show origin/main:<path>` as a
    // shell string, so a space split the argument and every such post read
    // as missing from main.
    const r = setup({ "_posts/2026-01-02-crème brûlée.md": "dessert, revised\n" });
    expect(r.changed).toEqual(["/blog/crème brûlée/"]);
    expect(r.new).toEqual([]);
    expect(r.unchanged.sort()).toEqual(["/", "/blog/", "/blog/café/", "/blog/old/"].sort());
  });
});

// The workflow steps, executed for real: the extracted `run:` script of the
// step that decides salience, over a real clone whose PR branch MOVES a file
// (identical content, so git's rename detection fires) or adds a non-ASCII
// name. `.cms-platform` points at this checkout, as the platform checkout
// does in CI.
test.describe("salience workflow steps over real git (cms-platform#539, renames)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  const POST = "<article>\n  <h1>{{ page.title }}</h1>\n  {{ content }}\n</article>\n";

  // A site whose `main` holds a layout, a post and an upload, and a work
  // tree checked out at `pr`, which applies `prFiles` (null deletes).
  function checkoutAfter(prFiles, base = "main") {
    sb = createSandbox("salience-step-");
    const src = sb.initRepo("src");
    sb.commit(
      src,
      {
        "_layouts/post.html": POST,
        "_posts/2026-01-01-old.md": "old post body\n",
        "assets/images/uploads/a.png": "png bytes of a\n",
      },
      "main",
    );
    // The base the PR targets: `main`, or a branch named like shell syntax.
    if (base !== "main") sb.git(src, ["branch", base, "main"]);
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    sb.commit(src, prFiles, "pr");
    const work = sb.fullClone(sb.publish(src));
    sb.git(work, ["checkout", "-q", "--detach", "origin/pr"]);
    fs.symlinkSync(path.resolve(__dirname, ".."), path.join(work, ".cms-platform"));
    return work;
  }

  // Runs the step and returns the raw result. `stubs` (name -> sh body) are
  // put first on PATH; mktemp files land in a private TMPDIR returned as
  // `tmp` so a leak is observable.
  function execute(workflowFile, stepName, work, stubs = {}, base = "main") {
    const [found] = findRunSteps(() => true).filter(
      (f) => f.workflow === workflowFile && f.step.name === stepName,
    );
    expect(found, `${workflowFile} has a step named ${stepName}`).toBeTruthy();
    const tmp = path.join(sb.root, "tmp");
    fs.mkdirSync(tmp, { recursive: true });
    // Failure messages still pass through stdout; keep their legacy log file
    // writes inside the fixture rather than writing /tmp/preview-media.log.
    const bin = writeStubs(path.join(sb.root, "stubs"), { tee: "cat", ...stubs });
    const r = runStep(found.step, {
      cwd: work,
      scratch: path.join(sb.root, `run-${found.job}`),
      env: { ...sb.env, TMPDIR: tmp, PATH: `${bin}:${path.dirname(process.execPath)}:${sb.env.PATH}` },
      stepEnv: { BASE: base, BASE_REF: base },
    });
    return { ...r, tmp };
  }

  function decide(workflowFile, stepName, work) {
    const r = execute(workflowFile, stepName, work);
    expect(r.status, `exit status; stderr: ${r.stderr}`).toBe(0);
    return r.output.trim();
  }

  const MOVE = (from, to, content) => ({ [from]: null, [to]: content });

  const VISUAL = ["visual-regression.yml", "Decide salience"];
  const MEDIA = ["preview-media.yml", "Detect media-salient changes"];

  const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const DIAGNOSTIC = "fatal: invalid%ref\r\n::error::injected\nlast diagnostic\n";
  const ESCAPED_DIAGNOSTIC = "fatal: invalid%25ref%0D%0A::error::injected%0Alast diagnostic";

  for (const target of [VISUAL, MEDIA]) {
    const salientDir = target === VISUAL ? "_layouts" : "assets/images/uploads";
    for (const [file, salient, listing] of [
      ["::error::x", false, "::error::x"],
      ["notes%\r\n::error::injected\n", false, "notes%25%0D%0A::error::injected%0A"],
      [`${salientDir}/odd%\r\n::error::injected\n`, true,
        `${salientDir}/odd%25%0D%0A::error::injected%0A`],
    ]) {
      test(`${target[0]}: safely lists ${JSON.stringify(file)} and preserves salient=${salient}`, () => {
        const work = checkoutAfter({ [file]: "changed\n" });
        const r = execute(...target, work);
        expect(r.status, r.stderr).toBe(0);
        expect(r.output.trim()).toBe(`salient=${salient}`);
        expect(r.stdout.split("\n").filter((line) => line.startsWith("  - "))).toEqual([`  - ${listing}`]);
        expect(r.stdout).not.toContain("\r");
        expect(r.stdout.split("\n").filter((line) => line.trimStart().startsWith("::error::"))).toEqual([]);
        expect(fs.readdirSync(r.tmp)).toEqual([]);
      });
    }

    test(`${target[0]}: a valid empty diff is non-salient and removes both temporary files`, () => {
      const work = checkoutAfter({});
      const r = execute(...target, work);
      expect(r.status, r.stderr).toBe(0);
      expect(r.output.trim()).toBe("salient=false");
      expect(r.stdout.split("\n").filter((line) => line.startsWith("  - "))).toEqual([]);
      expect(fs.readdirSync(r.tmp)).toEqual([]);
    });

    test(`${target[0]}: ignores changes only on the base branch (three-dot diff)`, () => {
      const work = checkoutAfter({ "notes.md": "content\n" });
      // Advance the actual local fixture remote, because the media history
      // helper fetches main and would overwrite a worktree-only tracking ref.
      const src = path.join(sb.root, "src");
      sb.git(src, ["checkout", "-q", "main"]);
      const baseHead = sb.commit(src, { "_layouts/post.html": "base branch edit\n" }, "base only");
      sb.git(path.join(sb.root, "origin.git"), ["fetch", "-q", src, `${baseHead}:refs/heads/main`]);
      sb.git(work, ["fetch", "-q", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
      const r = execute(...target, work);
      expect(r.status, r.stderr).toBe(0);
      expect(r.output.trim()).toBe("salient=false");
      expect(r.stdout).not.toContain("  - _layouts/post.html");
      expect(fs.readdirSync(r.tmp)).toEqual([]);
    });

    for (const partialDiff of [false, true]) {
      test(`${target[0]}: escapes failed diff stderr and refuses partial records (partial=${partialDiff})`, () => {
        const work = checkoutAfter({ "_config.yml": "title: changed\n" });
        const r = execute(...target, work, {
          git: `if [ "$1" = diff ]; then
${partialDiff ? "printf '_config.yml\\0'" : ":"}
printf '%s' '${DIAGNOSTIC}' >&2
exit 17
fi
exec '${REAL_GIT}' "$@"`,
        });
        expect(r.status, r.stderr).toBe(target === VISUAL ? 17 : 1);
        expect(r.output).toBe("");
        expect(r.stderr).not.toContain(DIAGNOSTIC);
        expect(r.stdout.split("\n").filter((line) => line.startsWith("Git diff diagnostic: "))).toEqual([
          `Git diff diagnostic: ${ESCAPED_DIAGNOSTIC}`,
        ]);
        expect(r.stdout).not.toContain("\r");
        expect(r.stdout).not.toContain("  - _config.yml");
        expect(r.stdout.split("\n").filter((line) => line.trimStart().startsWith("::error::"))).toEqual([]);
        expect(fs.readdirSync(r.tmp)).toEqual([]);
      });
    }
  }

  for (const failRefs of [false, true]) {
    test(`preview-media: escapes ref diagnostic output and preserves log-only status handling (failed=${failRefs})`, () => {
      const work = checkoutAfter({ "_config.yml": "title: changed\n" });
      const r = execute(...MEDIA, work, {
        // The history helper uses rev-parse with additional options. Fail only
        // the three diagnostic calls, after history verification has passed.
        git: `if { [ "$1" = rev-parse ] && { [ "$2" = HEAD ] || [ "$2" = origin/main ]; }; } || { [ "$1" = merge-base ] && [ "$3" = HEAD ]; }; then
printf '%s' '${DIAGNOSTIC}' ${failRefs ? ">&2" : ""}
exit ${failRefs ? 17 : 0}
fi
exec '${REAL_GIT}' "$@"`,
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.output.trim()).toBe("salient=true");
      expect(r.stderr).not.toContain(DIAGNOSTIC);
      expect(r.stdout.split("\n").filter((line) => line.endsWith(ESCAPED_DIAGNOSTIC))).toEqual([
        `HEAD            = ${ESCAPED_DIAGNOSTIC}`,
        `origin/main    = ${ESCAPED_DIAGNOSTIC}`,
        `merge-base      = ${ESCAPED_DIAGNOSTIC}`,
      ]);
      expect(r.stdout).not.toContain("\r");
      expect(r.stdout.split("\n").filter((line) => line.trimStart().startsWith("::error::"))).toEqual([]);
      expect(fs.readdirSync(r.tmp)).toEqual([]);
    });
  }

  test("visual-regression: moving a layout out of _layouts/ is salient", () => {
    const work = checkoutAfter(MOVE("_layouts/post.html", "uploads/post.html", POST));
    expect(decide(...VISUAL, work)).toBe("salient=true");
  });

  test("visual-regression: moving an upload between non-salient directories is not", () => {
    const work = checkoutAfter(MOVE("assets/images/uploads/a.png", "assets/images/b.png", "png bytes of a\n"));
    expect(decide(...VISUAL, work)).toBe("salient=false");
  });

  test("preview-media: moving a media-salient layout away is salient", () => {
    const work = checkoutAfter(MOVE("_layouts/post.html", "docs/post.html", POST));
    expect(decide(...MEDIA, work)).toBe("salient=true");
  });

  test("preview-media: moving an upload out of the media folder is salient", () => {
    const work = checkoutAfter(MOVE("assets/images/uploads/a.png", "docs/a.png", "png bytes of a\n"));
    expect(decide(...MEDIA, work)).toBe("salient=true");
  });

  for (const name of ["café.png", "with space.png", 'quote"d.png', "new\nline.png"]) {
    test(`preview-media: a new upload named ${JSON.stringify(name)} is salient (NUL-delimited)`, () => {
      const work = checkoutAfter({ [`assets/images/uploads/${name}`]: "img\n" });
      expect(decide(...MEDIA, work)).toBe("salient=true");
    });
  }

  // Shell syntax in a path must stay data: `$VAR`, `$(...)`, a backtick and
  // `;` are all legal in a file name, and an unquoted expansion would run or
  // split them. A marker file in the work tree shows if anything ran.
  const SHELL_NAMES = ["a$HOME.png", "b$(touch PWNED).png", "c`touch PWNED`.png", "d;touch PWNED;.png", "-e.png"];
  for (const name of SHELL_NAMES) {
    for (const [label, target] of [["preview-media", MEDIA], ["visual-regression", VISUAL]]) {
      const dir = label === "preview-media" ? "assets/images/uploads" : "_layouts";
      test(`${label}: a path named ${JSON.stringify(name)} is salient and never executed`, () => {
        const work = checkoutAfter({ [`${dir}/${name}`]: "x\n" });
        expect(decide(...target, work)).toBe("salient=true");
        expect(fs.existsSync(path.join(work, "PWNED")), "no path text ran as shell").toBe(false);
      });
    }
  }

  // The base branch name is also an interpolation: legal ref names carry `$`,
  // `(`, backticks and `;`.
  const HOSTILE_BASE = "rel/x$(>PWNED)`>PWNED`;>PWNED";
  for (const target of [MEDIA, VISUAL]) {
    test(`${target[0]}: a base branch named like shell syntax is read verbatim and never executed`, () => {
      const work = checkoutAfter({ "_config.yml": "title: x\n" }, HOSTILE_BASE);
      const r = execute(...target, work, {}, HOSTILE_BASE);
      expect(r.status, `exit status; stderr: ${r.stderr}`).toBe(0);
      expect(r.output.trim()).toBe("salient=true");
      expect(fs.existsSync(path.join(work, "PWNED")), "no branch text ran as shell").toBe(false);
    });
  }

  test("preview-media: a salient path that is not the first record is still found", () => {
    // README.md sorts first, so `^` and `$` must anchor per NUL record.
    const work = checkoutAfter({ "README.md": "edited\n", "_config.yml": "title: x\n" });
    expect(decide(...MEDIA, work)).toBe("salient=true");
  });

  test("preview-media: removes its temp file", () => {
    const work = checkoutAfter({ "_config.yml": "title: x\n" });
    const r = execute(...MEDIA, work);
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readdirSync(r.tmp)).toEqual([]);
  });

  // grep exits 1 for "no match" and 2+ when it FAILED; only 1 is "not
  // salient". A failed grep reading as not salient lets a media-salient PR
  // skip the required probe.
  for (const rc of [2, 127]) {
    test(`preview-media: a grep that fails (exit ${rc}) fails the step closed, no salient= output`, () => {
      const work = checkoutAfter({ "assets/images/uploads/new.png": "img\n" });
      const r = execute(...MEDIA, work, { grep: `exit ${rc}` });
      expect(r.status, "must not report success").not.toBe(0);
      expect(r.output).toBe("");
      expect(r.stdout).toContain("::error title=preview-media::");
      expect(fs.readdirSync(r.tmp), "temp file removed on the failure path too").toEqual([]);
    });
  }

  test("preview-media: a post edit with an odd name stays non-salient", () => {
    const work = checkoutAfter({ "_posts/2026-02-02-crème brûlée.md": "post\n" });
    expect(decide(...MEDIA, work)).toBe("salient=false");
  });

  test("detect-changed-pages: moving an include out of _includes/ still fans out", () => {
    // `_includes/` edits reach every page; the move's SOURCE is what says so.
    sb = createSandbox("salience-rename-detect-");
    const src = sb.initRepo("src");
    sb.commit(src, { "_includes/header.html": "<header>\n  nav\n</header>\n", "_posts/2026-01-01-old.md": "x\n" }, "main");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    sb.commit(src, MOVE("_includes/header.html", "uploads/header.html", "<header>\n  nav\n</header>\n"), "pr");
    const work = sb.fullClone(sb.publish(src));
    sb.git(work, ["checkout", "-q", "--detach", "origin/pr"]);
    const r = runDetect({ root: work, runDiscover: () => new Set(["/", "/blog/old/"]) });
    expect(r.changed.sort()).toEqual(["/", "/blog/old/"]);
    expect(r.unchanged).toEqual([]);
  });
});

test.describe("select-specs getChangedFiles (cms-platform#539, renames)", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  function clone(prFiles) {
    sb = createSandbox("select-specs-paths-");
    const src = sb.initRepo("src");
    sb.commit(src, { "_layouts/post.html": "<article>\n  {{ content }}\n</article>\n", "README.md": "r\n" }, "main");
    sb.git(src, ["checkout", "-q", "-b", "pr"]);
    sb.commit(src, prFiles, "pr");
    const work = sb.fullClone(sb.publish(src));
    sb.git(work, ["checkout", "-q", "--detach", "origin/pr"]);
    return work;
  }

  test("reads non-ASCII, quote, space and newline names verbatim", () => {
    const names = ["_layouts/café.html", '_includes/quote"d.html', "_includes/with space.html", "_data/new\nline.yml"];
    const work = clone(Object.fromEntries(names.map((n) => [n, "x\n"])));
    expect(getChangedFiles("origin/main", work).sort()).toEqual([...names].sort());
  });

  test("reads `$`, `(`, backtick and `;` names verbatim, and a base named like shell syntax", () => {
    const names = ["_data/a$HOME.yml", "_data/b$(touch PWNED).yml", "_data/c`touch PWNED`.yml", "_data/d;touch PWNED;.yml"];
    const work = clone(Object.fromEntries(names.map((n) => [n, "x\n"])));
    expect(getChangedFiles("origin/main", work).sort()).toEqual([...names].sort());
    const hostile = "rel/x$(>PWNED)`>PWNED`;>PWNED";
    sb.git(work, ["branch", "-f", hostile, "origin/main"]);
    expect(getChangedFiles(hostile, work).sort()).toEqual([...names].sort());
    expect(fs.existsSync(path.join(work, "PWNED")), "no ref text ran as shell").toBe(false);
  });

  test("a move lists the source as well as the destination", () => {
    const work = clone({ "_layouts/post.html": null, "uploads/post.html": "<article>\n  {{ content }}\n</article>\n" });
    expect(getChangedFiles("origin/main", work).sort()).toEqual(["_layouts/post.html", "uploads/post.html"]);
  });

  test("a missing base throws instead of substituting uncommitted changes", () => {
    const work = clone({ "x.txt": "x\n" });
    fs.writeFileSync(path.join(work, "café.html"), "new\n");
    expect(() => getChangedFiles("origin/no-such-branch", work)).toThrow();
  });
});
