#!/usr/bin/env node
"use strict";
/*
 * create-site — scaffold a new cms-platform site (thin shell).
 *
 *   npx github:Adam-S-Daniel/cms-platform <target-dir> \
 *       --owner Adam-S-Daniel --repo example.com --domain example.com --title "Example"
 *
 * Flags may be omitted; you'll be prompted. Copies the platform-owned files
 * (the admin/collections.site.yml.example seam reference, skills, thin
 * workflow callers, dependabot) from this repo and generates the site
 * identity (_config.yml, Gemfile, site-params.env). Content,
 * branding, and AWS values stay in the new site; platform machinery flows in
 * via the gem + reusable workflows (see docs/SYNC.md).
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { execFileSync } = require("child_process");

const PLATFORM_ROOT = path.resolve(__dirname, "..");
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";
// Documented offline FALLBACK only — used when resolvePlatformVersion() below
// can't reach GitHub. Refresh this on each platform release.
const PLATFORM_VERSION = "v0.1.52";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      out[a.slice(2)] = next === undefined || next.startsWith("--") ? true : argv[++i];
    } else out._.push(a);
  }
  return out;
}

// Resolve the platform release to pin this new site to. Precedence:
//   1. Explicit override: --platform-ref flag or CMS_PLATFORM_REF env var.
//   2. `gh api repos/<PLATFORM_REPO>/releases/latest --jq .tag_name` (if `gh`
//      is installed and authenticated).
//   3. GitHub REST API via global fetch (Node 18+), same endpoint.
//   4. Fallback to the baked-in PLATFORM_VERSION constant above.
async function resolvePlatformVersion(args) {
  const explicit = (args && args["platform-ref"]) || process.env.CMS_PLATFORM_REF;
  if (typeof explicit === "string" && explicit.trim()) {
    const ref = explicit.trim();
    console.log(`platform release: ${ref} (explicit override)`);
    return ref;
  }

  try {
    const out = execFileSync(
      "gh",
      ["api", `repos/${PLATFORM_REPO}/releases/latest`, "--jq", ".tag_name"],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 10000 },
    )
      .toString()
      .trim();
    if (/^v\d+\.\d+\.\d+$/.test(out)) {
      console.log(`platform release: ${out} (via gh)`);
      return out;
    }
  } catch (_) {
    /* swallow: gh absent, unauthenticated, network down, etc. */
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(`https://api.github.com/repos/${PLATFORM_REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const json = await res.json();
      const tag = json && json.tag_name;
      if (typeof tag === "string" && /^v\d+\.\d+\.\d+$/.test(tag)) {
        console.log(`platform release: ${tag} (via GitHub API)`);
        return tag;
      }
    }
  } catch (_) {
    /* swallow: network down, non-2xx, malformed JSON, etc. */
  }

  console.log(`platform release: ${PLATFORM_VERSION} (fallback constant — could not reach GitHub)`);
  return PLATFORM_VERSION;
}

function ask(rl, q, dflt) {
  return new Promise((res) => {
    rl.question(`${q}${dflt ? ` (${dflt})` : ""}: `, (ans) =>
      res((ans && ans.trim()) || dflt || "")
    );
  });
}

function copyTree(src, dest, transform) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d, transform);
    else {
      let buf = fs.readFileSync(s);
      if (transform && /\.(ya?ml|js|md|html|css|rb|env|json)$/.test(entry.name)) {
        buf = Buffer.from(transform(buf.toString("utf8")));
      }
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.writeFileSync(d, buf);
    }
  }
}

function write(dest, rel, content) {
  const p = path.join(dest, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const platformVersion = await resolvePlatformVersion(args);
  const rl = args.yes
    ? null
    : readline.createInterface({ input: process.stdin, output: process.stdout });
  const q = async (k, prompt, dflt) =>
    args[k] != null ? args[k] : rl ? await ask(rl, prompt, dflt) : dflt;

  const domain = await q("domain", "Production domain (apex, no scheme)", "example.com");
  const title = await q("title", "Site title", domain.split(".")[0]);
  const owner = await q("owner", "GitHub owner", "Adam-S-Daniel");
  const repo = await q("repo", "GitHub repo name", domain);
  const author = await q("author", "Author name", title);
  const target = path.resolve(args._[0] || (await q("dir", "Target directory", repo)));
  if (rl) rl.close();

  const prefix = domain.replace(/\./g, "-");
  const sub = (s) =>
    s
      .replace(/example-com/g, prefix)
      .replace(/example\.com/g, domain)
      .replace(/platform_ref:\s*v\d+\.\d+\.\d+/g, `platform_ref: ${platformVersion}`)
      .replace(/@v\d+\.\d+\.\d+/g, `@${platformVersion}`);

  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw new Error(`target ${target} is not empty`);
  fs.mkdirSync(target, { recursive: true });

  copyTree(path.join(PLATFORM_ROOT, "examples/site/.github"), path.join(target, ".github"), sub);
  // admin/ machinery ships via the cms-platform-theme gem (theme/admin) — sites
  // no longer vendor it. Seed only the seam reference (collections.site.yml.example)
  // so the site knows where its optional custom collections go.
  fs.mkdirSync(path.join(target, "admin"), { recursive: true });
  write(
    target,
    "admin/collections.site.yml.example",
    fs.readFileSync(path.join(PLATFORM_ROOT, "theme/admin/collections.site.yml.example"), "utf8"),
  );
  copyTree(path.join(PLATFORM_ROOT, "skills"), path.join(target, ".claude/skills"));

  // Pre-commit guards (secrets-scan + lint-staged) — platform-authoritative,
  // kept current by .github/workflows/dev-hooks-sync.yml. Seed the canonical
  // files + a SessionStart that wires them locally, so the guards are active on
  // the first clone (not only after the first sync PR lands). (issue #116)
  for (const f of [
    "scripts/secrets-scan.sh",
    "scripts/lint-staged.sh",
    "scripts/setup-hooks.sh",
    ".githooks/pre-commit",
    ".gitconfig-fragment",
  ]) {
    const dst = path.join(target, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(PLATFORM_ROOT, f), dst);
    if (/\.sh$|pre-commit$/.test(f)) fs.chmodSync(dst, 0o755);
  }
  write(target, ".claude/settings.json", DEV_HOOKS_SETTINGS_JSON);

  write(target, "_config.yml", configYml({ title, domain, author, owner, repo }));
  write(target, "Gemfile", GEMFILE);
  write(
    target,
    "infrastructure/site-params.env",
    sub(fs.readFileSync(path.join(PLATFORM_ROOT, "infrastructure/site-params.example.env"), "utf8"))
      .replace(/^export GITHUB_REPO=.*$/m, `export GITHUB_REPO="${repo}"`)
      .replace(/^export APEX_DOMAIN=.*$/m, `export APEX_DOMAIN="${domain}"`)
      .replace(/^export ALLOWED_ORIGINS=.*$/m, `export ALLOWED_ORIGINS="https://${domain}"`)
      .replace(/^export STACK_NAME=.*$/m, `export STACK_NAME="${prefix}-oauth-proxy"`)
  );
  write(
    target,
    "platform.lock",
    `# cms-platform lock — the platform release this site is pinned to.\n` +
      `# Bumped by the platform-bump workflow; Dependabot bumps the uses:@ pins\n` +
      `# and the theme gem in lockstep. See the platform's docs/SYNC.md.\n` +
      `platform_repo: ${PLATFORM_REPO}\n` +
      `platform_ref: ${platformVersion}\n`
  );

  write(target, "_posts/" + seedDate() + "-hello-world.md", SEED_POST(title));
  write(target, "pages/about.md", SEED_ABOUT(title));
  // Seed a NEUTRAL "replace me" placeholder logo. The gem ships only a neutral
  // placeholder (never a site's brand — issue #25); the render hooks default
  // cms.logo_url to <url>/assets/images/logo.svg, and this site-owned copy
  // SHADOWS the gem asset. The owner replaces it with their real logo (or sets
  // cms.logo_url). Reuse the gem placeholder so the two never drift; prepend a
  // "replace me" note for the new owner.
  write(target, "assets/images/logo.svg", seedLogo());
  write(target, "_e2e/canary-post.md", SEED_CANARY);
  write(target, "index.html", SEED_INDEX);
  // Seed the consuming-site half of the live-preview + graceful-404 contract
  // (issue #23). The gem ships theme/_layouts/preview.html + the admin
  // preview-bridge / native-preview-href scripts, but the admin "Live Preview"
  // link dead-ends on a raw S3 404 unless THIS site exposes the /preview/ PAGE;
  // likewise an unknown URL 404s ungracefully without a site 404.html. preview.md
  // is front-matter ONLY (the gem layout IS the shell); 404.html is a friendly
  // not-found page on the gem `default` layout. Locked by
  // e2e/scaffold-preview-and-404.test.js.
  write(target, "preview.md", SEED_PREVIEW);
  write(target, "404.html", SEED_404);
  write(target, ".gitignore", SITE_GITIGNORE);
  // The secrets-scan reusable runs the gitleaks binary with --config
  // .gitleaks.toml when present; ship the platform's fixture allowlist so a
  // fresh site scans clean. (gitleaks-action is license-gated for org repos,
  // so the reusable uses the binary — see .github/workflows/secrets-scan.yml.)
  write(target, ".gitleaks.toml", fs.readFileSync(path.join(PLATFORM_ROOT, ".gitleaks.toml"), "utf8"));
  write(target, "README.md", siteReadme({ title, domain, owner, repo, platformVersion }));

  // OAuth proxy + bootstrap DELEGATING deploy wrappers (#69). The site commits
  // ONLY these thin wrappers — never the OAuth proxy lambda.py/template.yaml or
  // the bootstrap CloudFormation template — and each checks the platform out at
  // platform_ref into .cms-platform/ and deploys the platform's stack under THIS
  // site's identity (from infrastructure/site-params.env). Keeps consumers from
  // forking the proxy/infra. Locked by e2e/scaffold-deploy-delegators.test.js.
  for (const rel of ["oauth-proxy/deploy.sh", "infrastructure/bootstrap/deploy.sh"]) {
    write(target, rel, fs.readFileSync(path.join(PLATFORM_ROOT, rel + ".delegating"), "utf8"));
    fs.chmodSync(path.join(target, rel), 0o755);
  }

  console.log(nextSteps({ target, domain, owner, repo, prefix }));
}

function configYml({ title, domain, author, owner, repo }) {
  return `title: ${title}
description: ""
url: "https://${domain}"
baseurl: ""
author:
  name: ${author}

theme: cms-platform-theme

markdown: kramdown
highlighter: rouge
permalink: /blog/:slug/

# Gem-shipped admin assets are copied into _site/admin by the post_write render
# hook (not generated by Jekyll), so Jekyll's cleanup phase would delete them
# each build (incl. in-test rebuilds) — a TOCTOU the e2e admin link-crawler
# HEADs into (transient 404). keep_files spares _site/admin from cleanup.
keep_files:
  - admin

cms:
  repository: ${owner}/${repo}
  oauth_base_url: ""

collections:
  projects: { output: false, permalink: /projects/:slug/ }
  tags: { output: true, permalink: /tags/:slug/ }
  e2e: { output: true, permalink: /e2e/:slug/ }

defaults:
  - { scope: { path: "", type: "posts" },    values: { layout: "post" } }
  - { scope: { path: "", type: "projects" }, values: { layout: "project" } }
  - { scope: { path: "", type: "tags" },     values: { layout: "tag" } }
  - { scope: { path: "pages" },              values: { layout: "page" } }
  - { scope: { path: "", type: "e2e" },      values: { layout: "canary", sitemap: false, robots: "noindex,nofollow" } }

plugins:
  - jekyll-seo-tag
  - jekyll-feed
  - jekyll-sitemap

exclude:
  - Gemfile
  - Gemfile.lock
  - infrastructure
  - oauth-proxy
  - scripts
  - README.md
  - "*.env"
  # The e2e lane checks the platform out into .cms-platform/ and (for the
  # local lane) PLACES the harness at <site>/e2e. Neither is site content;
  # excluding them keeps the harness (specs, configs, node_modules) and the
  # platform checkout out of _site so they can't pollute the build or break
  # the e2e-posts-exclusion / sitemap specs that read _site. (.cms-platform
  # is dot-prefixed so Jekyll ignores it by default; listing it is explicit.)
  - e2e
  - .cms-platform
  - platform.lock
  - admin/collections.site.yml.example
`;
}

// SessionStart wiring for the platform-delivered pre-commit guards. Runs the
// (sync-managed) setup-hooks.sh idempotently each session so secrets-scan +
// lint-staged are wired into git config on every clone. (issue #116)
const DEV_HOOKS_SETTINGS_JSON =
  JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume",
            hooks: [
              {
                type: "command",
                command: 'bash "$CLAUDE_PROJECT_DIR/scripts/setup-hooks.sh"',
                timeout: 30,
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  ) + "\n";

const GEMFILE = `source "https://rubygems.org"
gem "jekyll", "~> 4.3"
gem "webrick"

group :jekyll_plugins do
  gem "cms-platform-theme", git: "https://github.com/Adam-S-Daniel/cms-platform", glob: "theme/*.gemspec"
end
`;

// The site-owned placeholder logo seeded into assets/images/logo.svg. It's the
// gem's NEUTRAL placeholder (read from theme/assets/images/logo.svg so the two
// can't drift) with a leading "replace me" note for the new owner. The owner
// drops in their real logo here (it shadows the gem asset) or sets cms.logo_url.
function seedLogo() {
  const gemLogo = fs.readFileSync(
    path.join(PLATFORM_ROOT, "theme/assets/images/logo.svg"),
    "utf8",
  );
  const note =
    "<!--\n" +
    "  REPLACE ME. This is a neutral placeholder logo for your new site's /admin.\n" +
    "  Drop in your own logo at this path (assets/images/logo.svg) or set\n" +
    "  cms.logo_url in _config.yml. This file shadows the cms-platform-theme gem's\n" +
    "  placeholder; until you replace it, /admin shows the generic mark below.\n" +
    "-->\n";
  // Keep the gem's own <svg> + override comment; just prepend the owner note
  // (after any XML declaration, so the decl stays first).
  const m = gemLogo.match(/^(<\?xml[^>]*\?>\s*)/);
  return m ? m[1] + note + gemLogo.slice(m[1].length) : note + gemLogo;
}

const seedDate = () => new Date().toISOString().slice(0, 10);
const SEED_POST = (t) => `---
title: Hello world
date: ${new Date().toISOString().slice(0, 19).replace("T", " ")} +0000
published: true
---

Welcome to ${t}. Edit or replace this post in the CMS at \`/admin/\`.
`;
const SEED_ABOUT = (t) => `---
title: About
layout: page
permalink: /pages/about/
published: true
---

About ${t}.
`;
const SEED_CANARY = `---
layout: canary
title: E2E Canary
permalink: /e2e/canary-post/
canary_id: canary-post
sitemap: false
robots: "noindex,nofollow"
---
E2E canary entry
`;
const SEED_INDEX = `---
layout: default
title: Home
---
<h1>{{ site.title }}</h1>
<ul>
{% for post in site.posts %}<li><a href="{{ post.url | relative_url }}">{{ post.title }}</a></li>{% endfor %}
</ul>
`;
// The admin "Live Preview" surface (issue #23). Front-matter ONLY — the gem
// theme/_layouts/preview.html IS the shell (it hosts the hidden post/page/
// project variants the admin preview-bridge streams draft content into). It
// HARDCODES `<meta name="robots" content="noindex, nofollow">`, so we DON'T
// add a front-matter robots here (a second one would duplicate the meta) —
// mirrors adamdaniel.ai/preview.md.
const SEED_PREVIEW = `---
layout: preview
permalink: /preview/
sitemap: false
title: "Live Preview"
description: "Internal CMS preview surface — not a real post."
---
`;
// A friendly not-found page on the gem \`default\` layout (issue #23). Generic +
// site-agnostic; links back to home and the blog. The default layout renders
// \`page.robots\` from front-matter, so this carries a real noindex,nofollow.
const SEED_404 = `---
layout: default
permalink: /404.html
sitemap: false
robots: "noindex,nofollow"
title: Page Not Found
description: The page you were looking for does not exist.
---
<div class="container">
  <div class="page-header page-not-found">
    <p class="page-not-found__code" aria-hidden="true">404</p>
    <h1>Page not found</h1>
    <p class="page-not-found__message">
      The page you were looking for doesn't exist, or it may have moved.
    </p>
  </div>
  <div class="page-content page-not-found__actions">
    <p>
      <a href="{{ '/' | relative_url }}">Return to the homepage</a>
      or browse the
      <a href="{{ '/blog/' | relative_url }}">blog</a>.
    </p>
  </div>
</div>
`;
const SITE_GITIGNORE = `_site/
.jekyll-cache/
Gemfile.lock
vendor/
infrastructure/site-params.env
.bundle/
admin/config.yml
admin/config-local.yml
`;

function siteReadme({ title, domain, owner, repo, platformVersion }) {
  return `# ${title}

A [cms-platform](https://github.com/${PLATFORM_REPO}) site. Machinery (theme,
workflows, infra, skills) flows in from the platform; this repo holds the
content + identity.

- Production: https://${domain}
- Repo: ${owner}/${repo}
- Platform: \`${PLATFORM_REPO}@${platformVersion}\` (see \`platform.lock\`)

## Local dev

\`\`\`bash
bundle install
bundle exec jekyll serve
\`\`\`
`;
}

function nextSteps({ target, domain, owner, repo, prefix }) {
  return `
✓ Scaffolded ${repo} at ${target}

Next:
  1. cd ${target} && git init && git add -A && git commit -m "Initial site from cms-platform"
  2. Create GitHub repo ${owner}/${repo} and push.
  3. Edit infrastructure/site-params.env (GitHub OAuth app id/secret, etc.).
  4. Deploy infra (one-time, shared AWS account):
       set -a; source infrastructure/site-params.env; set +a
       bash infrastructure/bootstrap/deploy.sh   # committed delegating wrapper
       bash oauth-proxy/deploy.sh                # committed delegating wrapper (scope repo,user,workflow)
  5. Add GitHub secrets (exact fine-grained PAT permissions: see
     .claude/skills/cms-platform-secrets/SKILL.md):
       - CMS_E2E_PAT      this repo: Contents R/W, Pull requests R/W, Actions R/W; PAT user = reviewer of the regression-review env
       - CMS_PLATFORM_PAT same + Workflows R/W -- for platform-bump
       - AWS_ROLE_ARN, PREVIEW_CLOUDFRONT_ID, PRODUCTION_CLOUDFRONT_ID (bootstrap stack outputs)
     Also enable Settings -> General -> Allow auto-merge.
  6. Set the repo VARIABLES the reusable workflows read via vars.* (CMS_APEX,
     CMS_PROD_URL, PREVIEW_BUCKET, AWS_REGION) — all DERIVED from APEX_DOMAIN in
     infrastructure/site-params.env, so nothing is retyped:
       set -a; source infrastructure/site-params.env; set +a
       bash <cms-platform>/scripts/set-repo-variables.sh        # add --dry-run to preview
     (Leave PROD_PLAYGROUND_MODE unset on a real prod site so the prod-mutate
     loop stays report-only; set PROD_PLAYGROUND_MODE=true in site-params.env
     only for a throwaway sandbox you want the loop to actually mutate.)
  7. Set _config.yml cms.oauth_base_url to the oauth-proxy ApiUrl output.
  8. Point ${domain} + *.${domain} DNS at the CloudFront distributions.
  9. If ${owner} is a GitHub ORG with OAuth App access restrictions enabled, an
     org owner must approve the CMS OAuth App before editors can save (login
     works, but saves fail until then — see jodidaniel#27). Check with:
       node <cms-platform>/scripts/preflight-oauth.js --repo ${owner}/${repo}
 10. Add ${owner}/${repo} to cms-platform's repo-settings.yml under \`repos:\`
     (usually \`main: consumer-main\` + \`cms-feature-branches\`) so the daily
     repo-settings drift audit governs the new repo's settings/rulesets, then
     apply them: node <cms-platform>/scripts/audit-repo-settings.js --fix --yes --repo ${owner}/${repo}

Resource prefix: ${prefix}   Buckets: ${prefix}-{cfn-artifacts,previews,production}
`;
}

if (require.main === module) {
  main().catch((e) => {
    console.error("create-site:", e.message);
    process.exit(1);
  });
}

module.exports = { resolvePlatformVersion, PLATFORM_VERSION };
