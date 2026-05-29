#!/usr/bin/env node
"use strict";
/*
 * create-site — scaffold a new cms-platform site (thin shell).
 *
 *   npx github:Adam-S-Daniel/cms-platform <target-dir> \
 *       --owner Adam-S-Daniel --repo example.com --domain example.com --title "Example"
 *
 * Flags may be omitted; you'll be prompted. Copies the platform-owned files
 * (admin/, skills, thin workflow callers, dependabot) from this repo and
 * generates the site identity (_config.yml, Gemfile, site-params.env). Content,
 * branding, and AWS values stay in the new site; platform machinery flows in
 * via the gem + reusable workflows (see docs/SYNC.md).
 */
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const PLATFORM_ROOT = path.resolve(__dirname, "..");
const PLATFORM_REPO = "Adam-S-Daniel/cms-platform";
const PLATFORM_VERSION = "v0.1.0";

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
      .replace(/platform_ref:\s*v0\.1\.0/g, `platform_ref: ${PLATFORM_VERSION}`)
      .replace(/@v0\.1\.0/g, `@${PLATFORM_VERSION}`);

  if (fs.existsSync(target) && fs.readdirSync(target).length)
    throw new Error(`target ${target} is not empty`);
  fs.mkdirSync(target, { recursive: true });

  copyTree(path.join(PLATFORM_ROOT, "examples/site/.github"), path.join(target, ".github"), sub);
  copyTree(path.join(PLATFORM_ROOT, "admin"), path.join(target, "admin"));
  copyTree(path.join(PLATFORM_ROOT, "skills"), path.join(target, ".claude/skills"));

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
  write(target, ".platform-version", PLATFORM_VERSION + "\n");

  write(target, "_posts/" + seedDate() + "-hello-world.md", SEED_POST(title));
  write(target, "pages/about.md", SEED_ABOUT(title));
  write(target, "_e2e/canary-post.md", SEED_CANARY);
  write(target, "index.html", SEED_INDEX);
  write(target, ".gitignore", SITE_GITIGNORE);
  write(target, "README.md", siteReadme({ title, domain, owner, repo }));

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
`;
}

const GEMFILE = `source "https://rubygems.org"
gem "jekyll", "~> 4.3"
gem "webrick"

group :jekyll_plugins do
  gem "cms-platform-theme", git: "https://github.com/Adam-S-Daniel/cms-platform", glob: "theme/*.gemspec"
end
`;

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
const SITE_GITIGNORE = `_site/
.jekyll-cache/
Gemfile.lock
vendor/
infrastructure/site-params.env
.bundle/
admin/config.yml
admin/config-local.yml
`;

function siteReadme({ title, domain, owner, repo }) {
  return `# ${title}

A [cms-platform](https://github.com/${PLATFORM_REPO}) site. Machinery (theme,
workflows, infra, skills) flows in from the platform; this repo holds the
content + identity.

- Production: https://${domain}
- Repo: ${owner}/${repo}
- Platform: \`${PLATFORM_REPO}@${PLATFORM_VERSION}\` (see \`.platform-version\`)

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
       bash <cms-platform>/infrastructure/bootstrap/deploy.sh
       bash <cms-platform>/oauth-proxy/deploy.sh
  5. Add GitHub secrets: AWS_ROLE_ARN, PREVIEW_CLOUDFRONT_ID, PRODUCTION_CLOUDFRONT_ID
     (+ optional CMS_PLATFORM_PAT for sync PRs).
  6. Set _config.yml cms.oauth_base_url to the oauth-proxy ApiUrl output.
  7. Point ${domain} + *.${domain} DNS at the CloudFront distributions.

Resource prefix: ${prefix}   Buckets: ${prefix}-{cfn-artifacts,previews,production}
`;
}

main().catch((e) => {
  console.error("create-site:", e.message);
  process.exit(1);
});
