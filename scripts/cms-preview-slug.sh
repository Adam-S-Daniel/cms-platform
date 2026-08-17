#!/usr/bin/env bash
#
# Derive a DNS-safe, length-bounded preview slug from a Decap CMS head ref.
#
# Decap editorial PRs use `cms/<collection>/<entry>` head refs. The preview
# pipeline (.github/workflows/deploy-preview.yml) publishes a second,
# draft-cycle-stable alias at `preview-cms-<slug>.<apex-domain>`, syncing the
# build to the S3 prefix `cms-<slug>/`. The CloudFront preview-router
# (infrastructure/bootstrap/template.yaml) maps that host back to the prefix
# purely by string match `^preview-cms-([a-z0-9-]+)\.<apex>$`, so the ONLY
# constraints on <slug> are that `preview-cms-<slug>` be a valid DNS label:
# lowercase [a-z0-9-] and <= 63 octets. `preview-cms-` is 12 chars, so <slug>
# must be <= 51 chars — otherwise the host's first label exceeds the 63-octet
# DNS limit, can't resolve, and the Deployments-API registration that embeds
# it fails the deploy-preview job (the failure this guards).
#
# Output: the bounded slug on stdout (no trailing newline), or empty for a
# non-cms/* branch. Both the deploy and teardown jobs call this so they always
# agree on which `cms-<slug>/` prefix to publish and later clean up — a drift
# between them would orphan S3 objects at PR close.
#
# Domain-agnostic: the `preview-cms-` prefix length is the only constant, so
# this script is reused verbatim by every site built on the platform.
#
# Usage: cms-preview-slug.sh <branch-ref>
set -euo pipefail

BRANCH="${1-}"

# Regular code PRs key their preview off the PR number alone — no alias.
# Emit nothing; callers gate the downstream steps on `slug != ''`.
if [[ "$BRANCH" != cms/* ]]; then
  exit 0
fi

# `cms/<col>/<entry>` -> `<col>-<entry>`, then folded to the [a-z0-9-] charset
# the router regex (and the DNS-label rules) already declare above.
#
# The fold is a SECURITY boundary, not just tidiness. The branch ref is
# attacker-influenced input — a Decap editor picks the entry title that becomes
# the ref — and callers embed this output in shell. Before the fold a single
# quote survived verbatim, so `cms/a/'$(id)'` yielded `a-'$(id)'`, and a caller
# line of the shape `SLUG='<slug>'` rendered as `SLUG='a-'$(id)''` and EXECUTED
# `id`. Constraining the charset removes every shell metacharacter at the
# source; deploy-preview.yml separately passes this value via `env:` rather
# than string interpolation, so neither half stands alone.
#
# Uppercase folds to `-` like any other out-of-charset byte. It used to pass
# through on the theory that a stray capital should 404 loudly at the router
# rather than mis-route — but the same pass-through is what let a quote reach
# a shell, and Decap's slug template emits lowercase anyway, so no real ref
# relies on it.
#
# Collapse runs of hyphens and trim the ends: a DNS label may not begin or end
# with one, and a doubled hyphen would spend the 51-char budget on nothing. An
# entry that folds away entirely (all punctuation) yields the empty string,
# which callers already gate on (`slug != ''`) and so skips the alias rather
# than publishing to a bare `cms-/` prefix.
slug=$(printf '%s' "$BRANCH" |
  sed -E 's|^cms/||; s|/|-|g; s|[^a-z0-9-]|-|g; s|-+|-|g; s|^-||; s|-$||')

# Bound to a valid DNS label. `preview-cms-` (12) + slug must be <= 63, so
# slug <= 51. On overflow keep a readable 42-char prefix and append a short
# content hash: deterministic (same entry -> same host across Decap's
# close/reopen draft cycles) and collision-resistant (two long titles sharing
# a 42-char prefix still differ). 42 + 1 separator + 8 hex = 51.
MAX_SLUG=51
if ((${#slug} > MAX_SLUG)); then
  hash=$(printf '%s' "$slug" | { sha256sum 2>/dev/null || shasum -a 256; } | cut -c1-8)
  prefix=$(printf '%s' "${slug:0:42}" | sed -E 's/-+$//')
  slug="${prefix}-${hash}"
fi

printf '%s' "$slug"
