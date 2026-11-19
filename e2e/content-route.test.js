// @lane: local — pure logic, plus real git repos in os.tmpdir(); no network
//
// The content route (e2e/content-route.js): a consumer pull request that
// changes CMS content only skips the browser matrix and the site verifier's
// self-tests, so a brittle test cannot block a publish (adamdaniel.ai PR 5001).
//
// What these tests hold:
//   1. the rule: `content` is the narrow answer and every doubt is `full`;
//   2. the composite that feeds it (.github/actions/content-route): driven
//      over REAL git, on a real merge commit, with `npm` stubbed so nothing
//      touches the network;
//   3. the wiring: in e2e-tests.yml every work step carries the route
//      condition, so a step added later cannot silently run (or be skipped)
//      on the wrong route;
//   4. visual review: a CMS edit to a file collection skips it, the site's
//      publish gate never does.
const { test, expect } = require("./base");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const { createSandbox } = require("./git-fixture");
const { readWorkflow, parseYaml } = require("./workflow-yaml-utils");
const { routeChange, siteGatePath, cmsDataFiles, seamFolders, parseNulRaw } = require("./content-route");
const { isSalientChange } = require("./visual-regression-salient");
const { YAML_PACKAGE_ENV, loadTrustedYaml } = require("./trusted-yaml");

const ROUTE_CLI = path.join(__dirname, "content-route.js");
const YAML_PACKAGE = path.dirname(require.resolve("yaml/package.json"));
// The files the rule needs at run time, as a job has them under `.cms-platform`.
const PLATFORM_FILES = [
  "e2e/content-route.js",
  "e2e/trusted-yaml.js",
  "e2e/visual-regression-salient.js",
  "scripts/content-pr-guard.js",
];
function copyPlatform(dest) {
  for (const rel of PLATFORM_FILES) {
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", rel), path.join(dest, rel));
  }
  return dest;
}
const ACTION = path.join(__dirname, "..", ".github", "actions", "content-route", "action.yml");
const ROUTE_CONDITION = "steps.route.outputs.route != 'content'";
// What both workflows hand the composite: a boolean that is true only for a
// same-repository `cms/` pull request, and the pull request's head commit.
const ROUTE_WITH = {
  "from-cms":
    "${{ github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.event.pull_request.head.ref, 'cms/') }}",
  "head-sha": "${{ github.event.pull_request.head.sha }}",
};

// jodidaniel.com's shape: folder collections, file collections under
// `_data/`, and a publish gate that is one of those files.
const SEAM = `collections:
  - name: expertise
    folder: "_expertise"
  - name: tools
    folder: _tools
  - name: site_about
    files:
      - name: about
        file: "_data/about.yml"
  - name: site_settings
    files:
      - name: settings
        file: "_data/settings.yml"
`;
const CONFIG = `title: Example
cms:
  site_gate:
    path: _data/settings.yml
    field: site_live
`;
const CONFIG_NO_GATE = "title: Example\ncms:\n  branch_prefix: cms/\n";

const CMS = { fromCms: true, seamYamlText: SEAM, configYamlText: CONFIG, YAML };
const route = (records, opts = CMS) => routeChange(records, opts).route;
// Records as `git diff --raw` gives them for a plain regular file.
const NONE = "000000";
const FILE = "100644";
const M = (p) => ({ status: "M", path: p, oldMode: FILE, newMode: FILE });
const A = (p) => ({ status: "A", path: p, oldMode: NONE, newMode: FILE });
const D = (p) => ({ status: "D", path: p, oldMode: FILE, newMode: NONE });

test.describe("content-route: the rule", () => {
  test("a post, its upload, a page, a tag and a seam folder entry are content, added, edited or deleted", () => {
    expect(route([A("_posts/2026-11-18-quoting.md"), A("assets/images/uploads/img_2020.jpeg")])).toBe("content");
    expect(route([M("_posts/2026-11-18-quoting.md")])).toBe("content");
    expect(route([D("_posts/2026-11-18-quoting.md")])).toBe("content");
    expect(route([M("pages/about.md"), A("_tags/ai.md"), M("_e2e/canary-post.md")])).toBe("content");
    expect(route([M("_expertise/1-digital-health.md")])).toBe("content");
  });

  test("a non-ASCII, spaced or newline-bearing content path is still content", () => {
    expect(route([A("_posts/2026-01-01-crème brûlée.md")])).toBe("content");
    expect(route([A("assets/images/uploads/new\nline.png")])).toBe("content");
  });

  test("anything outside CMS-managed content is full, alone or mixed with content", () => {
    for (const p of [
      "_layouts/post.html",
      "_includes/header.html",
      "_config.yml",
      "Gemfile.lock",
      ".github/workflows/e2e-tests.yml",
      "admin/collections.site.yml",
      "assets/css/site.css",
      "scripts/verify-build-artifacts.rb",
      "README.md",
      "_data/navigation.yml",
      "_postsX/x.md",
    ]) {
      expect(route([M(p)]), p).toBe("full");
      expect(route([M("_posts/2026-01-01-x.md"), M(p)]), `post + ${p}`).toBe("full");
    }
  });

  test("a tools entry is CMS-managed but stays full: its page embeds an app", () => {
    expect(route([M("_tools/memory-map.md")])).toBe("full");
    expect(route([A("_tools/new-tool.md")])).toBe("full");
  });

  test("an EDIT to a CMS file collection is content; adding or deleting one is full", () => {
    expect(route([M("_data/about.yml")])).toBe("content");
    expect(route([M("_data/about.yml"), A("assets/images/uploads/photo.jpg")])).toBe("content");
    expect(route([A("_data/about.yml")])).toBe("full");
    expect(route([D("_data/about.yml")])).toBe("full");
  });

  test("the site's publish gate is full: taking a site live runs the whole suite", () => {
    expect(route([M("_data/settings.yml")])).toBe("full");
    expect(route([M("_data/about.yml"), M("_data/settings.yml")])).toBe("full");
  });

  test("a file collection is full whenever the gate cannot be told apart from it", () => {
    const edit = [M("_data/about.yml")];
    // No YAML parser, no config, a config that does not parse, a malformed gate.
    expect(route(edit, { ...CMS, YAML: null })).toBe("full");
    expect(route(edit, { ...CMS, configYamlText: null })).toBe("full");
    expect(route(edit, { ...CMS, configYamlText: "cms: [unclosed" })).toBe("full");
    expect(route(edit, { ...CMS, configYamlText: "cms:\n  site_gate: yes\n" })).toBe("full");
    expect(route(edit, { ...CMS, configYamlText: "cms:\n  site_gate:\n    field: site_live\n" })).toBe("full");
    // A site that declares no gate has none to protect.
    expect(route(edit, { ...CMS, configYamlText: CONFIG_NO_GATE })).toBe("content");
    // None of that touches a folder collection: no config is read for it.
    expect(route([M("_posts/2026-01-01-x.md")], { ...CMS, YAML: null, configYamlText: null })).toBe("content");
  });

  test("not from the CMS, an empty diff or an unreadable record is full", () => {
    const post = [M("_posts/2026-01-01-x.md")];
    expect(route(post, { ...CMS, fromCms: false })).toBe("full");
    expect(route(post, {})).toBe("full");
    expect(route([])).toBe("full");
    expect(route(null)).toBe("full");
    expect(route([{ ...M("x"), path: "" }])).toBe("full");
    expect(route([{ status: "M", oldMode: FILE, newMode: FILE }])).toBe("full");
    expect(route([null])).toBe("full");
  });

  test("only a plain add, edit or delete of a REGULAR file is content", () => {
    const post = "_posts/2026-01-01-x.md";
    // A record without modes cannot be told apart from a symlink.
    expect(route([{ status: "M", path: post }])).toBe("full");
    // A symlink, a submodule, an executable, and a type change (`T`).
    expect(route([{ status: "A", path: post, oldMode: NONE, newMode: "120000" }])).toBe("full");
    expect(route([{ status: "A", path: "pages/sub", oldMode: NONE, newMode: "160000" }])).toBe("full");
    expect(route([{ status: "A", path: post, oldMode: NONE, newMode: "100755" }])).toBe("full");
    expect(route([{ status: "M", path: post, oldMode: FILE, newMode: "100755" }])).toBe("full");
    expect(route([{ status: "T", path: post, oldMode: FILE, newMode: "120000" }])).toBe("full");
    expect(route([{ status: "D", path: post, oldMode: "120000", newMode: NONE }])).toBe("full");
    // Statuses `--no-renames` should never produce are not trusted either.
    for (const status of ["R", "C", "U", "X"]) {
      expect(route([{ status, path: post, oldMode: FILE, newMode: FILE }]), status).toBe("full");
    }
    expect(route([M(post)])).toBe("content");
  });

  test("a content directory is not proof of content: entries are Markdown, uploads are plain media", () => {
    for (const p of [
      "pages/home.html",
      "pages/app.js",
      "_posts/2026-01-01-x.html",
      "_posts/_plugin.rb",
      "_e2e/config.yml",
      "_expertise/x.liquid",
      "assets/images/uploads/sw.js",
      "assets/images/uploads/x.html",
      "assets/images/uploads/logo.svg",
      "assets/images/uploads/noextension",
      "assets/images/uploads/photo.png.html",
    ]) {
      expect(route([A(p)]), p).toBe("full");
    }
    for (const p of [
      "pages/about.md",
      "_posts/2026-01-01-x.markdown",
      "assets/images/uploads/photo.PNG",
      "assets/images/uploads/img_2020.jpeg",
      "assets/images/uploads/paper.pdf",
      "assets/images/uploads/clip.mp4",
    ]) {
      expect(route([A(p)]), p).toBe("content");
    }
  });

  test("a seam folder must be one underscore directory that is not machinery", () => {
    // content-pr-guard reads the seam with a line regex, which also matches a
    // `folder:` inside a hint. None of these may become content.
    const seam = `collections:
  - name: notes
    folder: _notes
    hint: |
      folder: .github
  - { name: a, folder: assets/css }
  - { name: b, folder: _layouts }
  - { name: c, folder: _data }
  - { name: d, folder: "_plugins" }
  - { name: e, folder: . }
`;
    expect(seamFolders(seam)).toEqual(["_notes/"]);
    const opts = { ...CMS, seamYamlText: seam };
    expect(route([A("_notes/x.md")], opts)).toBe("content");
    for (const p of [".github/workflows/e2e.md", "assets/css/x.md", "_layouts/x.md", "_data/x.md", "_plugins/x.md", "x.md"]) {
      expect(route([A(p)], opts), p).toBe("full");
    }
  });

  test("a file collection outside _data/ is never ordinary content, whatever the seam says", () => {
    // Pointing a Decap file collection at `_config.yml` is a documented pattern.
    const seam = `${SEAM}  - name: site_config
    files:
      - name: config
        file: "_config.yml"
      - name: nav
        file: "_includes/nav.html"
      - name: odd
        file: "_data/../_config.yml"
`;
    const opts = { ...CMS, seamYamlText: seam };
    expect(cmsDataFiles({ seamYamlText: seam, configYamlText: CONFIG, YAML })).toEqual(["_data/about.yml"]);
    for (const p of ["_config.yml", "_includes/nav.html", "_data/../_config.yml"]) {
      expect(route([M(p)], opts), p).toBe("full");
      expect(route([M("_data/about.yml"), M(p)], opts), `about + ${p}`).toBe("full");
      expect(isSalientChange([M(p)], { fromCms: true, YAML, cmsFiles: cmsDataFiles({ seamYamlText: seam, configYamlText: CONFIG, YAML }) }), p).toBe(true);
    }
    expect(route([M("_data/about.yml")], opts)).toBe("content");
  });

  test("a gate path not written in normal form is 'cannot tell', so nothing is exempt", () => {
    for (const written of ["./_data/settings.yml", "/_data/settings.yml", "_data//settings.yml", "_data/./settings.yml", "_data/x/../settings.yml", "settings.yml", " _data/settings.yml"]) {
      const config = `cms:\n  site_gate:\n    path: "${written}"\n`;
      expect(siteGatePath(config, YAML), written).toEqual({ known: false });
      expect(cmsDataFiles({ seamYamlText: SEAM, configYamlText: config, YAML }), written).toEqual([]);
      // The edit that takes the site live, and any other data file with it.
      expect(route([M("_data/settings.yml")], { ...CMS, configYamlText: config }), written).toBe("full");
      expect(route([M("_data/about.yml")], { ...CMS, configYamlText: config }), written).toBe("full");
    }
  });

  test("a site with no seam still routes the base collections", () => {
    const bare = { fromCms: true, seamYamlText: null, configYamlText: null, YAML: null };
    expect(route([A("_posts/2026-01-01-x.md")], bare)).toBe("content");
    expect(route([M("_expertise/x.md")], bare)).toBe("full");
  });

  test("the reason names the path JSON-quoted, so a newline cannot start a log line", () => {
    const { reason } = routeChange([M("_layouts/a\n::error::x.html")], CMS);
    expect(reason).not.toContain("\n");
    expect(reason).toContain('"_layouts/a\\n::error::x.html"');
  });

  test("siteGatePath never reads 'cannot tell' as 'no gate'", () => {
    expect(siteGatePath(CONFIG, YAML)).toEqual({ known: true, path: "_data/settings.yml" });
    expect(siteGatePath(CONFIG_NO_GATE, YAML)).toEqual({ known: true, path: null });
    expect(siteGatePath("title: x\n", YAML)).toEqual({ known: true, path: null });
    expect(siteGatePath(CONFIG, null)).toEqual({ known: false });
    expect(siteGatePath(null, YAML)).toEqual({ known: false });
    expect(siteGatePath("- a\n- b\n", YAML)).toEqual({ known: false });
    expect(siteGatePath("cms: 3\n", YAML)).toEqual({ known: false });
  });

  test("cmsDataFiles is the seam's files minus the gate, and empty when the gate is unknown", () => {
    expect(cmsDataFiles({ seamYamlText: SEAM, configYamlText: CONFIG, YAML })).toEqual(["_data/about.yml"]);
    expect(cmsDataFiles({ seamYamlText: SEAM, configYamlText: CONFIG_NO_GATE, YAML })).toEqual([
      "_data/about.yml",
      "_data/settings.yml",
    ]);
    expect(cmsDataFiles({ seamYamlText: SEAM, configYamlText: CONFIG, YAML: null })).toEqual([]);
    expect(cmsDataFiles({ seamYamlText: null, configYamlText: CONFIG, YAML })).toEqual([]);
  });
});

test.describe("visual review and CMS file collections", () => {
  const cmsFiles = cmsDataFiles({ seamYamlText: SEAM, configYamlText: CONFIG, YAML });
  const salient = (records, opts) => isSalientChange(records, { YAML, ...opts });

  test("a CMS edit to a file collection skips the review; the publish gate keeps it", () => {
    expect(salient([M("_data/about.yml")], { fromCms: true, cmsFiles })).toBe(false);
    expect(salient([M("_data/settings.yml")], { fromCms: true, cmsFiles })).toBe(true);
  });

  test("the skip needs the CMS, an EDIT, and a listed file", () => {
    expect(salient([M("_data/about.yml")], { fromCms: false, cmsFiles })).toBe(true);
    expect(salient([A("_data/about.yml")], { fromCms: true, cmsFiles })).toBe(true);
    expect(salient([D("_data/about.yml")], { fromCms: true, cmsFiles })).toBe(true);
    expect(salient([M("_data/navigation.yml")], { fromCms: true, cmsFiles })).toBe(true);
    expect(salient([M("_data/about.yml")], { fromCms: true })).toBe(true);
    // A template in the same pull request still gets its review.
    expect(salient([M("_data/about.yml"), M("_layouts/home.html")], { fromCms: true, cmsFiles })).toBe(true);
  });
});

// ── The composite, over real git ────────────────────────────────────────
// A site repo with a base commit on `main`, a `cms/` branch, and the merge
// commit GitHub checks out for a pull request (first parent = base tip).
function mergeRepo(sb, prFiles, { baseFiles = {} } = {}) {
  const repo = sb.initRepo("site");
  sb.commit(
    repo,
    {
      "README.md": "base\n",
      "_config.yml": CONFIG,
      "admin/collections.site.yml": SEAM,
      "_data/about.yml": "bio: old\n",
      "_data/settings.yml": "site_live: false\n",
      "_posts/2026-01-01-old.md": "---\ntitle: Old\n---\nold\n",
      ...baseFiles,
    },
    "base",
  );
  sb.git(repo, ["checkout", "-q", "-b", "cms/posts/x"]);
  sb.commit(repo, prFiles, "pr");
  sb.git(repo, ["checkout", "-q", "main"]);
  // A later base commit, so HEAD^1 (base tip) differs from the merge base.
  sb.commit(repo, { "README.md": "base moved\n" }, "base moves");
  sb.git(repo, ["merge", "-q", "--no-ff", "-m", "merge", "cms/posts/x"]);
  return repo;
}

function actionStep() {
  const action = YAML.parse(fs.readFileSync(ACTION, "utf8"));
  expect(action.runs.using).toBe("composite");
  expect(action.runs.steps).toHaveLength(1);
  const [step] = action.runs.steps;
  expect(step.id).toBe("route");
  expect(step.shell).toBe("bash");
  expect(action.outputs.route.value).toBe("${{ steps.route.outputs.route }}");
  expect(Object.keys(step.env).sort()).toEqual(["PLATFORM_DIR", "ROUTE_FROM_CMS", "ROUTE_HEAD_SHA"]);
  return step;
}

// Run the composite's script the way the runner does (`bash -e -o pipefail`).
// `npm` is a stub: "ok" links the harness's own `yaml` into the requested
// prefix (what a real install produces), "fail" exits 1, and either records
// that it was called. Nothing reaches the network.
//
// The platform is a REAL directory at `<repo>/.cms-platform`, as in the jobs
// (never a symlink: Node resolves a symlink to its real path first, which
// would hide what the workspace's own `node_modules` can shadow), WITHOUT
// node_modules, so `yaml` is reachable only through the stubbed install.
function runAction(sb, repo, { fromCms = "true", event = "pull_request", npm = "fail", headSha, extraEnv = {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(sb.root, "run-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const called = path.join(scratch, "npm-called");
  const body =
    npm === "ok"
      ? `prefix=""; prev=""; for a in "$@"; do if [ "$prev" = "--prefix" ]; then prefix="$a"; fi; prev="$a"; done
mkdir -p "$prefix/node_modules" && ln -sfn "${YAML_PACKAGE}" "$prefix/node_modules/yaml"`
      : "exit 1";
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho called >> "${called}"\n${body}\n`);
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  const platform = path.join(repo, ".cms-platform");
  fs.rmSync(platform, { recursive: true, force: true });
  copyPlatform(platform);
  const script = path.join(scratch, "step.sh");
  const output = path.join(scratch, "github_output");
  fs.writeFileSync(script, actionStep().run);
  fs.writeFileSync(output, "");
  let head = headSha;
  if (head === undefined) {
    const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^2"], { cwd: repo, encoding: "utf8", env: sb.env });
    head = r.status === 0 ? r.stdout.trim() : "0".repeat(40);
  }
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...sb.env,
      PATH: `${bin}:${path.dirname(process.execPath)}:${sb.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: output,
      GITHUB_WORKSPACE: repo,
      RUNNER_TEMP: scratch,
      ROUTE_FROM_CMS: fromCms,
      ROUTE_HEAD_SHA: head,
      PLATFORM_DIR: ".cms-platform",
      ...extraEnv,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: fs.readFileSync(output, "utf8"),
    npmCalled: fs.existsSync(called),
    scratch,
  };
}

test.describe("content-route: the composite over a real merge commit", () => {
  let sb;
  test.afterEach(() => sb && sb.cleanup());

  const POST = { "_posts/2026-11-18-quoting.md": "---\ntitle: Q\nfeatured_image_alt: Dean Ball\n---\nbody\n" };

  test("a new post with an upload routes content, without installing anything", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...POST, "assets/images/uploads/img 2020.jpeg": "bytes\n" });
    const r = runAction(sb, repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toBe("route=content\n");
    expect(r.npmCalled).toBe(false);
    expect(r.stdout).toContain("::notice title=content route::");
  });

  test("the diff is the pull request's NET change against the base tip, not the last push", () => {
    // The base moved (README.md) after the branch was cut. A merge-base or
    // two-dot diff taken the wrong way round would list README.md and route
    // full; HEAD^1..HEAD lists only the post.
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, POST);
    expect(sb.git(repo, ["diff", "--name-only", "HEAD^1", "HEAD"])).toBe("_posts/2026-11-18-quoting.md\n");
    expect(runAction(sb, repo).output).toBe("route=content\n");
  });

  test("a post plus a layout routes full", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...POST, "_layouts/post.html": "<html></html>\n" });
    const r = runAction(sb, repo);
    expect(r.status, r.stderr).toBe(0);
    expect(r.output).toBe("route=full\n");
    expect(r.stdout).not.toContain("::notice title=content route::");
  });

  test("a file collection edit routes content once yaml installs, and full when it cannot", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { "_data/about.yml": "bio: new\n" });
    const ok = runAction(sb, repo, { npm: "ok" });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.npmCalled).toBe(true);
    expect(ok.output).toBe("route=content\n");

    const failed = runAction(sb, repo, { npm: "fail" });
    expect(failed.status, failed.stderr).toBe(0);
    expect(failed.output).toBe("route=full\n");
    expect(failed.stdout).toContain("::warning::could not install yaml");
  });

  test("the publish gate routes full even with yaml installed", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { "_data/settings.yml": "site_live: true\n" });
    expect(runAction(sb, repo, { npm: "ok" }).output).toBe("route=full\n");
  });

  test("a pull request cannot widen its own route: the seam is read from the base", () => {
    // The branch adds `_layouts` to the seam as if it were a collection.
    sb = createSandbox("content-route-");
    const widened = `${SEAM}  - name: sneaky\n    folder: _layouts\n`;
    const repo = mergeRepo(sb, { "admin/collections.site.yml": widened, "_layouts/post.html": "x\n" });
    expect(runAction(sb, repo).output).toBe("route=full\n");
    // And even with the seam untouched in the diff, the base's seam decides.
    sb.cleanup();
    sb = createSandbox("content-route-");
    const repo2 = mergeRepo(sb, { "_layouts/post.html": "x\n" });
    expect(runAction(sb, repo2).output).toBe("route=full\n");
  });

  test("not a pull request, not from the CMS, or not a merge commit: full, and the step still succeeds", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, POST);
    for (const opts of [{ event: "workflow_dispatch" }, { event: "schedule" }, { fromCms: "false" }, { fromCms: "" }]) {
      const r = runAction(sb, repo, opts);
      expect(r.status, JSON.stringify(opts) + r.stderr).toBe(0);
      expect(r.output, JSON.stringify(opts)).toBe("route=full\n");
    }
    // A plain (non-merge) HEAD has no second parent.
    sb.git(repo, ["checkout", "-q", "--detach", "HEAD^1"]);
    const plain = runAction(sb, repo);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.output).toBe("route=full\n");
  });

  test("a classifier that is missing or broken is full, never content", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, POST);
    const head = sb.rev(repo, "HEAD^2");
    const scratch = fs.mkdtempSync(path.join(sb.root, "broken-"));
    const output = path.join(scratch, "out");
    for (const body of [null, "process.stdout.write('content-ish'); process.exit(0);", "throw new Error('boom');"]) {
      const platform = fs.mkdtempSync(path.join(scratch, "p-"));
      if (body !== null) {
        fs.mkdirSync(path.join(platform, "e2e"));
        fs.writeFileSync(path.join(platform, "e2e", "content-route.js"), body);
      }
      fs.writeFileSync(output, "");
      const script = path.join(scratch, "step.sh");
      fs.writeFileSync(script, actionStep().run);
      const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
        cwd: repo,
        encoding: "utf8",
        env: {
          ...sb.env,
          PATH: `${path.dirname(process.execPath)}:${sb.env.PATH}`,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: scratch,
          ROUTE_FROM_CMS: "true",
          ROUTE_HEAD_SHA: head,
          PLATFORM_DIR: platform,
        },
      });
      expect(r.status, String(body) + r.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8"), String(body)).toBe("route=full\n");
    }
  });

  // The hole an independent review found (PR 1055): the classifier runs from
  // `<workspace>/.cms-platform`, and a bare `require("yaml")` walks up into
  // `<workspace>/node_modules` — the pull request's own tree — before it looks
  // anywhere else. A committed `node_modules/yaml` could print `content` and
  // exit, skipping every test for a change to anything.
  const HIJACK = {
    "node_modules/yaml/package.json": '{"name":"yaml","version":"9.9.9","main":"index.js"}\n',
    "node_modules/yaml/index.js":
      'require("node:fs").writeFileSync(process.env.HIJACK_MARKER, "ran"); process.stdout.write("content"); process.exit(0);\n',
  };

  test("a yaml module committed by the pull request is never loaded: a layout change stays full", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...HIJACK, "_layouts/default.html": "<html>owned</html>\n" });
    for (const npm of ["fail", "ok"]) {
      const marker = path.join(sb.root, `hijack-${npm}`);
      const r = runAction(sb, repo, { npm, extraEnv: { HIJACK_MARKER: marker } });
      expect(r.status, r.stderr).toBe(0);
      expect(r.output, `npm ${npm}`).toBe("route=full\n");
      expect(fs.existsSync(marker), `the committed module must not run (npm ${npm})`).toBe(false);
    }
  });

  test("a committed yaml module cannot answer for a data file either: the real parser decides", () => {
    // With a `_data/` edit the step installs yaml. The committed module would
    // answer `content` for the publish gate; the installed one says full.
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...HIJACK, "_data/settings.yml": "site_live: true\n" });
    const marker = path.join(sb.root, "hijack-gate");
    const r = runAction(sb, repo, { npm: "ok", extraEnv: { HIJACK_MARKER: marker } });
    expect(r.output).toBe("route=full\n");
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("the parser's directory cannot be inherited or point into the workspace", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...HIJACK, "_data/about.yml": "bio: new\n" });
    const marker = path.join(sb.root, "hijack-env");
    // An inherited value naming the committed module is dropped by the step;
    // with the install failing there is then no parser, so the edit is full.
    const r = runAction(sb, repo, {
      npm: "fail",
      extraEnv: {
        HIJACK_MARKER: marker,
        [YAML_PACKAGE_ENV]: path.join(repo, "node_modules", "yaml"),
        NODE_PATH: path.join(repo, "node_modules"),
      },
    });
    expect(r.output).toBe("route=full\n");
    expect(fs.existsSync(marker)).toBe(false);
    // And the loader itself refuses a relative path, a path inside the
    // workspace, a missing directory and a module that is not a YAML parser.
    const notYaml = path.join(sb.root, "not-yaml");
    fs.mkdirSync(notYaml);
    fs.writeFileSync(path.join(notYaml, "index.js"), "module.exports = { parse: 3 };\n");
    expect(loadTrustedYaml({})).toBe(null);
    expect(loadTrustedYaml({ [YAML_PACKAGE_ENV]: "node_modules/yaml" })).toBe(null);
    expect(loadTrustedYaml({ [YAML_PACKAGE_ENV]: path.join(sb.root, "missing") })).toBe(null);
    expect(loadTrustedYaml({ [YAML_PACKAGE_ENV]: notYaml })).toBe(null);
    expect(loadTrustedYaml({ [YAML_PACKAGE_ENV]: YAML_PACKAGE, GITHUB_WORKSPACE: path.dirname(YAML_PACKAGE) })).toBe(null);
    expect(typeof loadTrustedYaml({ [YAML_PACKAGE_ENV]: YAML_PACKAGE, GITHUB_WORKSPACE: repo }).parse).toBe("function");
  });

  test("the visual review classifier does not load a committed yaml module either", () => {
    // Before the fix this printed "false" (no review) for a layout change.
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, { ...HIJACK, "_layouts/default.html": "<html>owned</html>\n" });
    copyPlatform(path.join(repo, ".cms-platform"));
    const marker = path.join(sb.root, "hijack-vr");
    const r = spawnSync(
      process.execPath,
      [path.join(repo, ".cms-platform", "e2e", "visual-regression-salient.js"), "--status", "--base-rev", "HEAD^1"],
      {
        cwd: repo,
        input: "M\0_layouts/default.html\0",
        encoding: "utf8",
        env: { ...sb.env, VR_FROM_CMS: "true", HIJACK_MARKER: marker, GITHUB_WORKSPACE: repo },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("true");
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("a symlink, a type change or a submodule inside a content folder routes full", () => {
    sb = createSandbox("content-route-");
    const repo = sb.initRepo("site");
    sb.commit(
      repo,
      { "_config.yml": CONFIG, "admin/collections.site.yml": SEAM, "_posts/2026-01-01-old.md": "old\n", "_layouts/default.html": "x\n" },
      "base",
    );
    sb.git(repo, ["checkout", "-q", "-b", "cms/posts/x"]);
    // An existing post replaced by a symlink to a layout (status T), and a new
    // "upload" that is a symlink out of the tree.
    fs.rmSync(path.join(repo, "_posts/2026-01-01-old.md"));
    fs.symlinkSync("../_layouts/default.html", path.join(repo, "_posts/2026-01-01-old.md"));
    sb.git(repo, ["add", "-A"]);
    sb.git(repo, ["commit", "-q", "-m", "type change"]);
    sb.git(repo, ["checkout", "-q", "main"]);
    sb.git(repo, ["merge", "-q", "--no-ff", "-m", "merge", "cms/posts/x"]);
    expect(sb.git(repo, ["diff", "--raw", "--no-renames", "HEAD^1", "HEAD"])).toMatch(/^:100644 120000 \S+ \S+ T\t_posts/);
    expect(runAction(sb, repo).output).toBe("route=full\n");

    sb.cleanup();
    sb = createSandbox("content-route-");
    const repo2 = sb.initRepo("site");
    sb.commit(repo2, { "_config.yml": CONFIG, "admin/collections.site.yml": SEAM }, "base");
    sb.git(repo2, ["checkout", "-q", "-b", "cms/posts/x"]);
    fs.mkdirSync(path.join(repo2, "assets/images/uploads"), { recursive: true });
    fs.symlinkSync("/etc/hostname", path.join(repo2, "assets/images/uploads/p.png"));
    sb.git(repo2, ["add", "-A"]);
    sb.git(repo2, ["commit", "-q", "-m", "symlink upload"]);
    sb.git(repo2, ["checkout", "-q", "main"]);
    sb.git(repo2, ["merge", "-q", "--no-ff", "-m", "merge", "cms/posts/x"]);
    expect(runAction(sb, repo2).output).toBe("route=full\n");
  });

  test("the merge commit must be THIS pull request's: a different or missing head commit is full", () => {
    sb = createSandbox("content-route-");
    const repo = mergeRepo(sb, POST);
    expect(runAction(sb, repo).output).toBe("route=content\n");
    for (const headSha of ["f".repeat(40), "", "HEAD^2", sb.rev(repo, "HEAD^1"), sb.rev(repo, "HEAD^2").slice(0, 12)]) {
      const r = runAction(sb, repo, { headSha });
      expect(r.status, r.stderr).toBe(0);
      expect(r.output, JSON.stringify(headSha)).toBe("route=full\n");
    }
  });

  test("parseNulRaw reads modes and status, and refuses anything it does not know", () => {
    const sha = "a".repeat(40);
    expect(parseNulRaw(`:000000 100644 ${"0".repeat(40)} ${sha} A\0_posts/a b.md\0:100644 100644 ${sha} ${sha} M\0x\ny.md\0`)).toEqual([
      { oldMode: "000000", newMode: "100644", status: "A", path: "_posts/a b.md" },
      { oldMode: "100644", newMode: "100644", status: "M", path: "x\ny.md" },
    ]);
    expect(parseNulRaw("")).toEqual([]);
    for (const bad of [
      "M\0_posts/x.md\0",
      `:100644 100644 ${sha} ${sha} M\0`,
      `:100644 100644 ${sha} ${sha} R100\0a\0`,
      `:100644 100644 ${sha} ${sha} M\0a\0trailing\0`,
    ]) {
      expect(() => parseNulRaw(bad), JSON.stringify(bad)).toThrow();
    }
  });

  test("the CLI prints exactly one route word and exits 0 on garbage input", () => {
    for (const [input, args] of [
      ["M\0", ["--base-rev", "HEAD"]],
      ["", []],
      ["M\0_posts/x.md\0", ["--base-rev"]],
    ]) {
      const r = spawnSync(process.execPath, [ROUTE_CLI, ...args], {
        input,
        encoding: "utf8",
        env: { ...process.env, ROUTE_FROM_CMS: "true" },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("full");
    }
  });
});

// ── The wiring ──────────────────────────────────────────────────────────
test.describe("content-route: e2e-tests.yml", () => {
  const steps = parseYaml(readWorkflow("e2e-tests.yml")).jobs.project.steps;
  const index = (pred, what) => {
    const i = steps.findIndex(pred);
    expect(i, `e2e-tests.yml project job needs ${what}`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const routeAt = index((s) => s.id === "route", "a step with id `route`");

  test("the route is decided by the composite, after both checkouts and Node, from a boolean expression", () => {
    const route = steps[routeAt];
    expect(route.uses).toBe("./.cms-platform/.github/actions/content-route");
    expect(route.if, "the route step itself is unconditional").toBeUndefined();
    const siteCheckout = index(
      (s) => /^actions\/checkout@/.test(String(s.uses || "")) && !(s.with && s.with.repository),
      "a checkout of the site",
    );
    expect(steps[siteCheckout].with, "the merge commit and both parents").toEqual({ "fetch-depth": 2 });
    const platformCheckout = index(
      (s) => /^actions\/checkout@/.test(String(s.uses || "")) && s.with && s.with.path === ".cms-platform",
      "a checkout of the platform",
    );
    const node = index((s) => /^actions\/setup-node@/.test(String(s.uses || "")), "setup-node");
    expect(siteCheckout).toBeLessThan(routeAt);
    expect(platformCheckout).toBeLessThan(routeAt);
    expect(node).toBeLessThan(routeAt);
    expect(route.with).toEqual(ROUTE_WITH);
  });

  test("site-verify.yml decides the route with the same two expressions", () => {
    const verifySteps = parseYaml(readWorkflow("site-verify.yml")).jobs.verify.steps;
    const verifyRoute = verifySteps.find((s) => s.id === "route");
    expect(verifyRoute.uses).toBe("./.cms-platform/.github/actions/content-route");
    expect(verifyRoute.with).toEqual(ROUTE_WITH);
  });

  test("every work step after the route carries the route condition", () => {
    // The two failure-summary steps are the exception: they only post or
    // resolve a comment, and resolving an earlier head's red comment is right
    // on a content run too.
    const exempt = new Set(["Post failure summary", "Resolve failure summary on success"]);
    const after = steps.slice(routeAt + 1);
    expect(after.length).toBeGreaterThanOrEqual(8);
    // The WHOLE condition, not a substring: `always() || <route condition>`
    // would contain it and run on every route.
    const allowed = new Set([
      `\${{ ${ROUTE_CONDITION} }}`,
      `\${{ inputs.target == 'local' && ${ROUTE_CONDITION} }}`,
      `\${{ !cancelled() && ${ROUTE_CONDITION} }}`,
    ]);
    for (const s of after) {
      if (exempt.has(s.name)) continue;
      expect(
        allowed.has(String(s.if || "")),
        `step ${JSON.stringify(s.name || s.uses)} must be gated on the route; its if is ${JSON.stringify(s.if)}`,
      ).toBe(true);
    }
    for (const name of exempt) {
      expect(steps.some((s) => s.name === name), `${name} still exists`).toBe(true);
    }
  });

  test("nothing before the route does work a content run should skip", () => {
    for (const s of steps.slice(0, routeAt)) {
      expect(typeof s.run, `step ${JSON.stringify(s.name || s.uses)} runs before the route`).toBe("undefined");
    }
  });

  test("the gate is unchanged: it needs the matrix and reports its rolled-up result", () => {
    const gate = parseYaml(readWorkflow("e2e-tests.yml")).jobs.e2e;
    expect(gate.needs).toBe("project");
    expect(String(gate.steps[0].run)).toContain('"${MATRIX_RESULT}" != "success"');
  });
});
