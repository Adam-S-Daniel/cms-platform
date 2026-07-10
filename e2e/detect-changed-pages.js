const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// ROOT — the SITE repo root, where `git diff origin/main...HEAD` must run and
// where _site/_posts/_projects/_tags/pages live. When the harness sits AT the
// site root, `path.resolve(__dirname, "..")` IS the site (default). When the
// platform is CONSUMED, this file runs from `<site>/.cms-platform/e2e/`, where
// the platform-relative `..` points at the SHALLOW platform checkout (no
// origin/main → `git diff` fails with "no merge base"). SITE_ROOT /
// GITHUB_WORKSPACE both name the SITE checkout (the one fetched with
// fetch-depth:0 + `git fetch origin main`). Mirrors playwright.config.js's
// SITE_ROOT resolution.
const ROOT = process.env.SITE_ROOT || process.env.GITHUB_WORKSPACE || path.resolve(__dirname, "..");

function git(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: "utf-8" }).trim();
}

function fileExistsOnMain(filePath) {
  try {
    execSync(`git show origin/main:${filePath}`, {
      cwd: ROOT,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function readFrontMatter(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function isPublished(filePath) {
  const fm = readFrontMatter(filePath);
  if (/^published:\s*false$/m.test(fm)) return false;
  return true;
}

// Admin shell URLs that the regression video should always include — these
// are the surfaces a content editor sees, so theme / bundle regressions on
// them are exactly what reviewers want to spot in the side-by-side video.
// `/preview/` is excluded because it's a CMS-driven canvas with no static
// state of its own — it'd just render an empty preview shell.
const ALWAYS_INCLUDED_ADMIN_PAGES = [
  "/admin/", // login screen
  "/admin/reviews/", // visual-regression review dashboard, unauth state
];

// The _site scan is the CANONICAL page universe: it discovers every page
// the build actually produced — including site-owned collections the
// hardcoded fallback below has never heard of (the /tools/ pages on
// adamdaniel.ai were invisible to the regression gate for exactly this
// reason). The reusable workflow therefore runs `jekyll build` BEFORE this
// script (locked by visual-regression-step-order.test.js); the fallback
// only serves local/harness runs without a build.
//
// `*/e2e/*` is excluded alongside admin/preview: the e2e canary fixtures
// are mutated by the publish-loop workflows between baseline resets, so a
// regression run racing a loop would flag a "different" canary and force
// the manual gate on a REQUIRED check for test-fixture churn.
//
// `rootDir` is injectable so tests can point the scan at a fixture tree.
function discoverAllPages(rootDir = ROOT) {
  const pages = new Set(["/"]);
  for (const p of ALWAYS_INCLUDED_ADMIN_PAGES) pages.add(p);
  const siteDir = path.join(rootDir, "_site");
  const useSiteScan = fs.existsSync(siteDir);

  if (useSiteScan) {
    const htmlFiles = execSync(
      `find ${siteDir} -name 'index.html' -not -path '*/admin/*' -not -path '*/preview/*' -not -path '*/e2e/*'`,
      { encoding: "utf-8" },
    )
      .trim()
      .split("\n")
      .filter(Boolean);

    for (const f of htmlFiles) {
      const rel = f.replace(siteDir, "").replace(/index\.html$/, "");
      pages.add(rel);
    }
    return pages;
  }

  pages.add("/blog/");

  const postsDir = path.join(rootDir, "_posts");
  if (fs.existsSync(postsDir)) {
    for (const f of fs.readdirSync(postsDir)) {
      if (!f.endsWith(".md")) continue;
      const fullPath = path.join(postsDir, f);
      if (!isPublished(fullPath)) continue;
      const slug = f.replace(/^\d{4}-\d{2}-\d{2}-/, "").replace(/\.md$/, "");
      pages.add(`/blog/${slug}/`);
    }
  }

  const projectsDir = path.join(rootDir, "_projects");
  if (fs.existsSync(projectsDir)) {
    for (const f of fs.readdirSync(projectsDir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.replace(/\.md$/, "");
      pages.add(`/projects/${slug}/`);
    }
  }

  const tagsDir = path.join(rootDir, "_tags");
  if (fs.existsSync(tagsDir)) {
    for (const f of fs.readdirSync(tagsDir)) {
      if (!f.endsWith(".md")) continue;
      const slug = f.replace(/\.md$/, "");
      pages.add(`/tags/${slug}/`);
    }
  }

  const pagesDir = path.join(rootDir, "pages");
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir)) {
      if (!f.endsWith(".md")) continue;
      const fullPath = path.join(pagesDir, f);
      if (!isPublished(fullPath)) continue;
      const fm = readFrontMatter(fullPath);
      const match = fm.match(/^permalink:\s*(.+)$/m);
      if (match) {
        pages.add(match[1].trim());
      } else {
        const slug = f.replace(/\.md$/, "");
        pages.add(`/pages/${slug}/`);
      }
    }
  }

  return pages;
}

function mapFileToUrls(filePath) {
  if (filePath.startsWith("_posts/") && filePath.endsWith(".md")) {
    const basename = path.basename(filePath, ".md");
    const slug = basename.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    return [`/blog/${slug}/`];
  }

  if (filePath.startsWith("_projects/") && filePath.endsWith(".md")) {
    const slug = path.basename(filePath, ".md");
    return [`/projects/${slug}/`];
  }

  if (filePath.startsWith("_tags/") && filePath.endsWith(".md")) {
    const slug = path.basename(filePath, ".md");
    return [`/tags/${slug}/`];
  }

  if (filePath.startsWith("pages/") && filePath.endsWith(".md")) {
    const fullPath = path.join(ROOT, filePath);
    if (fs.existsSync(fullPath)) {
      const fm = readFrontMatter(fullPath);
      const match = fm.match(/^permalink:\s*(.+)$/m);
      if (match) return [match[1].trim()];
    }
    const slug = path.basename(filePath, ".md");
    return [`/pages/${slug}/`];
  }

  if (filePath === "index.html") return ["/"];
  if (filePath === "blog/index.html") return ["/blog/"];
  if (filePath === "projects/index.html") return ["/projects/"];

  // Admin shell changes — touch /admin/ and /admin/reviews/ regardless of
  // which file was edited, since both pull the same bundle / theme assets.
  if (filePath.startsWith("admin/")) {
    return ["/admin/", "/admin/reviews/"];
  }

  if (
    filePath.startsWith("_layouts/") ||
    filePath.startsWith("_includes/") ||
    filePath.startsWith("assets/css/") ||
    filePath === "_config.yml"
  ) {
    return ["__ALL__"];
  }

  return [];
}

// Pure classifier — given the canonical page list and the changed-files
// list, decide which pages are changed / new / unchanged. Extracted so
// tests can hit it without a git environment.
//
// `fileExistsOnMain` is injected so tests don't need a real `origin/main`.
// In CI the production binding queries git; tests pass a pure stub.
function classifyPages({ allPages, changedFiles, fileExistsOnMain = () => true }) {
  const directlyChanged = new Set();
  const newPages = new Set();
  let globalChange = false;

  for (const file of changedFiles) {
    const urls = mapFileToUrls(file);
    for (const url of urls) {
      if (url === "__ALL__") {
        globalChange = true;
      } else {
        directlyChanged.add(url);
        // The always-included admin URLs (/admin/, /admin/reviews/)
        // always exist on main by construction — they're served from
        // admin/index.html and admin/reviews/index.html, which are
        // shipped in the repo. A new SIBLING file in admin/ (e.g.
        // admin/config-test.yml) shouldn't mark those URLs as new;
        // doing so makes regression-video.spec.js draw a "+ New Page"
        // placeholder for the prod side instead of the real
        // production admin, and the resulting video shows admin
        // pages with the wrong reference image.
        if (!fileExistsOnMain(file) && !ALWAYS_INCLUDED_ADMIN_PAGES.includes(url)) {
          newPages.add(url);
        }
      }
    }
  }

  const changed = [];
  const newList = [];
  const unchanged = [];

  for (const page of allPages) {
    if (newPages.has(page)) {
      newList.push(page);
    } else if (globalChange || directlyChanged.has(page)) {
      changed.push(page);
    } else {
      unchanged.push(page);
    }
  }

  return { changed, new: newList, unchanged };
}

// CLI entrypoint as a pure function. Injectable runGit / runDiscover
// so the failure path (truncated history, no merge base) can be
// covered by unit tests without mutating the real repo.
//
// THROWS on git failure — silent fallback to "empty changeset" was the
// exact bug that made visual-regression report `potentiallyAffected: 0`
// on every PR (audit finding #2).
function runDetect({
  runGit = git,
  runDiscover = discoverAllPages,
  runFileExists = fileExistsOnMain,
} = {}) {
  // Best-effort fetch of origin/main so the diff below has a base to
  // resolve against. Missing remote (offline dev) is fine — the diff
  // is the real gate.
  try {
    runGit("git fetch origin main 2>/dev/null || true");
  } catch {
    // ignore — the diff below will surface any real problem
  }

  const changedFiles = runGit("git diff --name-only origin/main...HEAD")
    .split("\n")
    .filter(Boolean);

  return classifyPages({
    allPages: runDiscover(),
    changedFiles,
    fileExistsOnMain: runFileExists,
  });
}

module.exports = {
  ALWAYS_INCLUDED_ADMIN_PAGES,
  classifyPages,
  discoverAllPages,
  fileExistsOnMain,
  mapFileToUrls,
  runDetect,
};

if (require.main === module) {
  // Historic gotcha: do NOT pass `--depth=1` to the fetch. The workflow
  // checks out with `fetch-depth: 0` (full history); a depth-1 fetch on
  // top of that converts the local clone to shallow and severs the
  // merge base, which then causes `git diff origin/main...HEAD` to
  // fail with "no merge base".
  const result = runDetect();
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
