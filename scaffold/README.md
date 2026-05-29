# Scaffolder

Creates a new cms-platform site (thin shell):

```bash
npx github:Adam-S-Daniel/cms-platform <target-dir> \
  --owner Adam-S-Daniel --repo example.com --domain example.com --title "Example"
# or interactively:
node scaffold/create-site.js <target-dir>
```

Generates `_config.yml` (identity + `cms:` block + `theme:`), `Gemfile` (pins the
theme gem in `:jekyll_plugins`), the thin workflow callers + `dependabot.yml`
(placeholders filled from your domain), copies the platform-owned `admin/` base
and `.claude/skills`, seeds minimal content (a post, an about page, the e2e
canary, an index), writes `infrastructure/site-params.env` and `platform.lock`,
and prints the bootstrap + DNS next steps.
