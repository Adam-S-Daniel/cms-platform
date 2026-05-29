# Fixture Site — local-lane self-test for the e2e harness

A minimal **consuming-site** fixture for the cms-platform e2e harness. It is
the validation vehicle (and the deferred platform self-CI target) for the
"consumed local lane": a real `jekyll build` of a SITE + `decap-server` +ault
the full Playwright project matrix (incl. `@admin-write` CMS round-trips), run
with the harness checked out from the platform rather than living in the site.

## What it is

- `_config.yml` — neutral identity (title "Fixture Site", url
  `https://fixture.example`, `cms.repository Adam-S-Daniel/cms-platform-fixture`)
  + the **excludes** that keep the consumed `e2e/` harness and `.cms-platform/`
  checkout out of `_site`.
- `Gemfile` — pins `cms-platform-theme` by **local path** (`../../theme`), so
  the fixture tests the working-tree theme + plugins + Decap render hook.
- `_posts/` — one normal public post (`hello-world`) + one `e2e-`-slug fixture
  post (`e2e-seed-fixture`) to exercise `feed_exclude`.
- `_e2e/canary-post.md` — the mandatory canary collection entry.
- `pages/about.md`, `index.html`, `blog/index.html`, `tags/index.html`,
  `feed.xml` — the site-owned listing/feed surfaces (filter on the shared
  `feed_exclude` marker).
- `admin/` — copied from the platform (as `scaffold/create-site.js` does for a
  real site); the theme's `decap_config_hook.rb` renders `config.yml` +
  `config-local.yml` into `_site/admin/` at build.

## Run the local lane against it

```bash
cd e2e
bundle install --gemfile=fixture-site/Gemfile      # installs into fixture-site/vendor (see .bundle config)
SITE_ROOT="$PWD/fixture-site" npx playwright test   # builds + serves the fixture, starts decap-server
```

`SITE_ROOT` makes `playwright.config.js`'s local `webServer` build/serve the
fixture; the harness's `REPO_ROOT = path.resolve(__dirname, "..")` site-file
reads still need the harness placed so its parent IS the site (the reusable
workflow copies the harness to `<site>/e2e/` to satisfy that). For local
simulation we instead point the specs' `REPO_ROOT` at the fixture by running
from a placed copy — see the orchestrator's validation notes.

Build artifacts (`_site/`, `vendor/`, `Gemfile.lock`, `.bundle/`, rendered
`admin/config*.yml`) are git-ignored.
