# Fixture Single-Page Site — `base_collections: []` opt-out self-test (#33)

A second consuming-site fixture for the cms-platform e2e harness, mirroring the
shape of a genuine **single-page consumer** (e.g. jodidaniel.com): it sets

```yaml
cms:
  base_collections: []   # v0.1.7 opt-out (#5) — hide ALL platform base collections
```

so /admin shows ONLY the site's own custom `notes` collection (spliced from
`admin/collections.site.yml`). It ships **no** `_posts`/blog, **no**
`_tags`/`_projects`, **no** `_e2e` canaries, **no** `e2e` collection.

## Why it exists

The platform e2e suite includes ~a dozen specs that assume the generic
collections + adamdaniel-shaped content exist. Before #33, an opted-out
consumer's e2e was permanently RED. This fixture is the platform's own proof
that those generic-content specs **SKIP cleanly** here (keyed on
`e2e/site-capabilities.js` predicates) while still **running fully** on the
full `e2e/fixture-site/`.

The skip-on-opted-out / run-on-full contract is asserted by
`e2e/base-collections-skip-meta.test.js`, which builds BOTH fixtures and
compares the guarded specs' outcomes.

## Build (what the meta-test does)

```sh
cd e2e/fixture-site-singlepage
bundle install
bundle exec jekyll build --quiet   # the theme gem's decap_config_hook renders _site/admin/config.yml
```
