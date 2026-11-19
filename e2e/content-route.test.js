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
const { routeChange, siteGatePath, cmsDataFiles } = require("./content-route");
const { isSalientChange } = require("./visual-regression-salient");

const ROUTE_CLI = path.join(__dirname, "content-route.js");
const ACTION = path.join(__dirname, "..", ".github", "actions", "content-route", "action.yml");
const ROUTE_CONDITION = "steps.route.outputs.route != 'content'";

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
const M = (p) => ({ status: "M", path: p });
const A = (p) => ({ status: "A", path: p });
const D = (p) => ({ status: "D", path: p });

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
    expect(route([{ status: "M", path: "" }])).toBe("full");
    expect(route([{ status: "M" }])).toBe("full");
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
  return step;
}

// Run the composite's script the way the runner does (`bash -e -o pipefail`).
// `npm` is a stub: "ok" links the harness's own `yaml` into the requested
// prefix (what a real install produces), "fail" exits 1, and either records
// that it was called. Nothing reaches the network.
function runAction(sb, repo, { fromCms = "true", event = "pull_request", npm = "fail" } = {}) {
  const scratch = fs.mkdtempSync(path.join(sb.root, "run-"));
  const bin = path.join(scratch, "bin");
  fs.mkdirSync(bin);
  const called = path.join(scratch, "npm-called");
  const yamlPkg = path.dirname(require.resolve("yaml/package.json"));
  const body =
    npm === "ok"
      ? `prefix=""; prev=""; for a in "$@"; do if [ "$prev" = "--prefix" ]; then prefix="$a"; fi; prev="$a"; done
mkdir -p "$prefix/node_modules" && ln -s "${yamlPkg}" "$prefix/node_modules/yaml"`
      : "exit 1";
  fs.writeFileSync(path.join(bin, "npm"), `#!/bin/sh\necho called >> "${called}"\n${body}\n`);
  fs.chmodSync(path.join(bin, "npm"), 0o755);
  // The platform as the job has it: the rule and the two modules it reads,
  // WITHOUT node_modules, so `yaml` resolves only through the stubbed install.
  const platform = path.join(scratch, "platform");
  for (const rel of ["e2e/content-route.js", "e2e/visual-regression-salient.js", "scripts/content-pr-guard.js"]) {
    fs.mkdirSync(path.dirname(path.join(platform, rel)), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", rel), path.join(platform, rel));
  }
  const script = path.join(scratch, "step.sh");
  const output = path.join(scratch, "github_output");
  fs.writeFileSync(script, actionStep().run);
  fs.writeFileSync(output, "");
  const r = spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...sb.env,
      PATH: `${bin}:${path.dirname(process.execPath)}:${sb.env.PATH}`,
      GITHUB_EVENT_NAME: event,
      GITHUB_OUTPUT: output,
      RUNNER_TEMP: scratch,
      ROUTE_FROM_CMS: fromCms,
      PLATFORM_DIR: platform,
    },
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    output: fs.readFileSync(output, "utf8"),
    npmCalled: fs.existsSync(called),
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
    const scratch = fs.mkdtempSync(path.join(sb.root, "broken-"));
    const output = path.join(scratch, "out");
    fs.writeFileSync(output, "");
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
          PLATFORM_DIR: platform,
        },
      });
      expect(r.status, String(body) + r.stderr).toBe(0);
      expect(fs.readFileSync(output, "utf8"), String(body)).toBe("route=full\n");
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
    const fromCms = String(route.with["from-cms"]);
    expect(fromCms).toContain("github.event_name == 'pull_request'");
    expect(fromCms).toContain("github.event.pull_request.head.repo.full_name == github.repository");
    expect(fromCms).toContain("startsWith(github.event.pull_request.head.ref, 'cms/')");
  });

  test("every work step after the route carries the route condition", () => {
    // The two failure-summary steps are the exception: they only post or
    // resolve a comment, and resolving an earlier head's red comment is right
    // on a content run too.
    const exempt = new Set(["Post failure summary", "Resolve failure summary on success"]);
    const after = steps.slice(routeAt + 1);
    expect(after.length).toBeGreaterThanOrEqual(8);
    for (const s of after) {
      if (exempt.has(s.name)) continue;
      expect(String(s.if || ""), `step ${JSON.stringify(s.name || s.uses)} must be gated on the route`).toContain(
        ROUTE_CONDITION,
      );
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
