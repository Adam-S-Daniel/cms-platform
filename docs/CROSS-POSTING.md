# Cross-posting to Mastodon + Substack

What this is: the reusable `cross-post.yml` workflow + its thin-caller
template, `scripts/cross_post/cross_post.py`, and the shape they enforce.
Read this before wiring cross-posting into a site, before changing
`cross_post.py`'s detect/render/verify/post logic, or before debugging a
cross-post run. Ported from adamdaniel.ai's site-local prototype
(cms-platform#442) — see `docs/VERSION-HISTORY.md`'s v0.1.109 entry for the
port's full rationale.

## What it does

On a push to `main` that touches `_posts/**` (or on a manual dispatch naming
one post), `cross-post.yml`:

1. Detects newly-published posts — on a push, diffs
   `github.event.before..github.sha` for `_posts/*.md` that went from
   unpublished (or absent) to `published: true`; on dispatch, takes the
   single `post_path` input (a backfill of an older post, or a re-run of one
   that failed to post the first time). Writes `cross-post-out/posts.json`
   and sets `changed`/`count` outputs.
2. When neither leg is configured (`mastodon_instance: ""` and
   `substack: false`, the caller template's defaults), prints
   `::notice::cross-posting is not configured for this site` and stops —
   every step after this one is gated on `steps.detect.outputs.changed ==
   'true'`, so a site that hasn't wired either leg gets a harmless no-op run.
3. Awaits the production deploy (push only) via the platform's
   `await-prod-deploy` composite, so the run never verifies or cross-posts
   against a stale pre-merge site.
4. Verifies each detected post's public URL serves a 200 before posting
   anywhere.
5. Renders (when `substack: true`) a Mastodon status, a Substack-ready
   Markdown body, and a job-summary section per post, and uploads them as
   the `cross-post-<run_id>` artifact (30-day retention).
6. Posts to Mastodon (when `mastodon_instance` is non-empty) — idempotently:
   see "Dedupe / idempotency" below.

## Inputs

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `prod_url` | string | *(required)* | Deployed production URL (scheme included, no trailing slash), e.g. `https://example.com`. Fed to `await-prod-deploy`'s `prod-url` on a push |
| `mastodon_instance` | string | `""` | Mastodon instance base URL, e.g. `https://hachyderm.io`. Empty skips the Mastodon leg entirely |
| `substack` | boolean | `false` | Render + upload the Substack-ready Markdown draft. Substack has no publish API — this only controls whether the draft is produced; posting it is always paste-by-hand |
| `post_path` | string | `""` | One `_posts/*.md` to cross-post on a `workflow_dispatch`-shaped caller (backfill or re-run). Ignored on a push |
| `dry_run` | boolean | `false` | Log what would be posted to Mastodon; post nothing |
| `visibility` | string | `public` | Mastodon post visibility (`public` / `unlisted` / `direct`) |
| `platform_repo` | string | `Adam-S-Daniel/cms-platform` | Where `cross_post.py` lives |
| `platform_ref` | string | `main` | Pin to the same ref as the caller's `uses:@ref` |

**Secret:** `MASTODON_ACCESS_TOKEN` (optional — when unset, `post-mastodon`
prints `::warning::Mastodon leg skipped: MASTODON_ACCESS_TOKEN is not set`
and exits 0, so the render/artifact/summary steps still complete).

## The thin caller's trigger shape

`examples/site/.github/workflows/cross-post.yml` owns the trigger the
reusable does not:

```yaml
on:
  push:
    branches: [main]
    paths:
      - '_posts/**'
      - '!_posts/2099-*'   # prod-loop canaries (test_fixture)
      - '!_posts/*-e2e-*'  # e2e specs
  workflow_dispatch:
    inputs:
      post_path: { type: string, required: true }
      dry_run:   { type: boolean, default: true }
      visibility: { type: choice, options: [public, unlisted, direct], default: public }
```

**Fixture exclusion is belt-and-suspenders.** `cross_post.py`'s own `detect`
subcommand skips a post whose front matter carries `test_fixture: true` or
whose slug starts with `e2e-` — the same discriminator the rest of the
platform uses — so excluding those paths in the caller's trigger isn't
required for correctness; it just saves the run entirely rather than paying
for a detect-and-skip.

## Dedupe / idempotency

Before posting, `post-mastodon` resolves the account (`verify_credentials`)
and scans its 40 most recent original statuses for a link to the post's URL;
a match is reported as `already-posted` and nothing is sent, so a manual
re-run or a `main` push that re-detects a post cannot double-post. Each POST
also carries an `Idempotency-Key` derived from a SHA-256 of the post URL. If
the dedupe lookup itself fails (a non-200 response), the run prints a warning
and posts anyway rather than silently skipping a real post.

## Substack is paste-by-hand — there's no publish API

After a run with `substack: true`, open the job summary (the render step
appends a section there) or download the `cross-post-<run_id>` artifact from
the run's page, copy the `<slug>.substack.md` content, and paste it into a
new Substack draft manually. The render step also writes `<slug>.status.txt`
(the Mastodon status) and `<slug>.meta.json` (title/subtitle/url/slug/date/
tags/featured_image) alongside it.

## Creating the Mastodon app token

On your Mastodon instance (e.g. `hachyderm.io`): **Preferences → Development
→ New application**. Grant it **`profile` and `write:statuses`** — `profile` only lets the dedupe step read the account's own id via `verify_credentials` (a `write:statuses`-only token gets a 403 there; measured 2026-09-22); no other scope is
needed, and the workflow never reads or writes anything else on the account.
Copy the generated access token into the site repo's **`MASTODON_ACCESS_TOKEN`**
Actions secret. Until the secret exists, `cross-post.yml` still runs to
completion (detect/verify/render/upload all happen when `substack: true`) —
only the Mastodon-posting step is skipped, with a `::warning::` in the run
log.

## The default is a no-op, on purpose

A site that copies the thin-caller template and changes nothing gets
`prod_url: https://example.com`, `mastodon_instance: ""`, and
`substack: false`. Every push to `_posts/**` on `main` still runs the
workflow, detects the newly-published post, and then prints
`::notice::cross-posting is not configured for this site` and stops — no
Mastodon posting attempt, no Substack render, no artifact. Turning on either
leg is a one-line edit to the caller's `with:` block plus (for Mastodon) a
repo secret.

## `await-prod-deploy` by local path, not a remote pin

The reusable's "Checkout platform scripts" step checks this repo out into
`.cms-platform/` at `platform_ref`, and the "Await production deploy" step
then references the composite by the LOCAL path that checkout produces —
`uses: ./.cms-platform/.github/actions/await-prod-deploy` — never
`Adam-S-Daniel/cms-platform/.github/actions/await-prod-deploy@<ref>`. A
consumer repo that enforces `sha_pinning_required` in its actions-permissions
policy rejects a cross-repository composite action referenced by tag or SHA
outright at job setup ("all actions must be pinned to a full-length commit
SHA" — GitHub applies this to a composite from ANOTHER repository too, not
just first-party `uses:` lines), and a platform composite is deliberately
never SHA-pinned-with-a-trailing-comment fleet-wide any more (see
`docs/PIN-CONSISTENCY.md`). The platform's own prod-mutating loop reusables
(`cms-publish-loop-prod.yml`, `cms-publish-loop-host.yml`,
`cms-media-roundtrip.yml`, `cms-scheduled-publish-loop.yml`) already call
`await-prod-deploy` the same way — `cross-post.yml` follows their shape
rather than reinventing one. `scripts/cross_post/tests/test_workflow_shape.py`
lint-locks this: it asserts the reusable's text never contains
`Adam-S-Daniel/cms-platform/.github/actions/` and that the local path is
actually used.

## Testing

`scripts/cross_post/cross_post.py` is stdlib + PyYAML only, and every
function that talks HTTP takes an injectable transport so the suite needs no
real network. `python3 -m pytest scripts/cross_post -q` runs:

- `test_detect.py` — front-matter parsing, slugging, site settings,
  `newly_published`/`is_fixture` detection, `detect_from_git` (both a fake
  `git` and a real throwaway repo).
- `test_render.py` — `describe_post`'s excerpt fallback chain, hashtag
  derivation, the exact Mastodon status format (including the length-cap
  word-boundary truncation), and `substack_markdown`'s embed-marker /
  relative-link rewriting.
- `test_mastodon.py` — `verify_live`'s polling/backoff, `post_mastodon`'s
  auth header, idempotency key, dedupe skip, dry-run, no-token skip, and
  that an error response body is NEVER printed (it may carry secrets).
- `test_cli.py` — the `detect`/`render`/`post-mastodon` subcommands end to
  end against a `tmp_path` fixture site.
- `test_workflow_shape.py` — the reusable + template shape lints described
  above.

`self-ci.yml`'s `python-unit-tests` job runs the full suite on every PR that
touches this repo, but is deliberately **not** one of the four required
status contexts (`repo-settings.yml`'s `platform-main` ruleset names
`actionlint` / `ruby-theme-specs` / `node-unit-lints` / `plugin-validate`
only) — adding a fifth required context is a `repo-settings.yml` decision,
not something a new lane should make by merely existing.

## Related

- `.github/workflows/cross-post.yml` — the reusable.
- `examples/site/.github/workflows/cross-post.yml` — the thin-caller
  template.
- `scripts/cross_post/cross_post.py` — the module.
- `.github/actions/await-prod-deploy/action.yml` — the composite that gates
  the run on the merge actually being live.
- `docs/PIN-CONSISTENCY.md` — why a composite is pinned by tag (or, crossing
  a repository boundary, invoked by local checked-out path) and never
  SHA-pinned-with-a-comment.
- `docs/VERSION-HISTORY.md` — the v0.1.109 entry for the port's full
  rationale.
