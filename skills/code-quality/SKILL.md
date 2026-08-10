---
name: code-quality
description: Reference for the per-language lint + static-analysis + style toolchain (ESLint/Prettier, Ruff/Bandit/mypy, RuboCop, ShellCheck/shfmt, yamllint/actionlint, Stylelint, markdownlint) — its rule relaxations and gotchas. Use when a contributor asks to "lint", "format", set up a linter for a new language, or understand why a lint rule is disabled. NOTE - the CI half described here is NOT wired up in cms-platform; read the "What actually runs" section first.
---

# Code quality toolchain

> ## What actually runs (read this first)
>
> **Most of this file describes a toolchain that is not wired up in cms-platform.** Verified against the repo: there is no `.github/workflows/code-quality.yml`, the root `package.json` has **no `scripts` key at all** (so `npm run lint` / `npm run format` cannot run), and there is no `pyproject.toml`, `.yamllint.yml`, or top-level `tests/`. AGENTS.md's own "Deliberate skips — NOT ported" list says `code-quality` was kept platform-internal and never shipped — but this skill *is* in the synced set, so it reached consumers describing machinery none of them have. The pointer below to "**AGENTS.md → Code quality**" as the canonical toolchain reference is also wrong: that heading is generic managed boilerplate and contains no toolchain table.
>
> What genuinely gates code in **cms-platform**:
>
> | lane | what it runs | hard-fail? |
> | --- | --- | --- |
> | `self-ci.yml` → `actionlint` | `actionlint` over `.github/workflows/*.yml` | yes |
> | `self-ci.yml` → `ruby-theme-specs` | `ruby theme/spec/*_test.rb` | yes |
> | `self-ci.yml` → `node-unit-lints` | the ~101 pure-fs `e2e/*.test.js` lints | yes |
> | `self-ci.yml` → `cfn-lint` | the CloudFormation templates | advisory |
> | `self-secrets-scan.yml` | gitleaks on the diff / history | yes |
> | local pre-commit | `scripts/lint-staged.sh` + `scripts/secrets-scan.sh` (each skips any tool not on `PATH`) | local only |
>
> The sections below remain useful as the **reference for the tools themselves** — the deliberate rule relaxations, the RuboCop-out-of-Gemfile trap, the 100-column house width — and describe a real setup on a consumer that has adopted it. Treat every command as "if that tool is configured here", and verify before quoting a config path.

Every language has a linter + static-analyzer + style tool, configured to pass at a strong-but-pragmatic strength.

## Run the checks

```bash
npm ci                              # JS/CSS/MD tools live in node_modules
npm run lint                        # eslint + stylelint + markdownlint
npm run format                      # prettier --write (JS only)

# Python (tools via pip; CI pins ruff/bandit/mypy)
ruff check && ruff format --check && mypy && bandit -r oauth-proxy scripts tests -c pyproject.toml

# Ruby — standalone, Ruby >= 3.3 (NOT bundle exec; see below)
gem install rubocop:1.86.2 rubocop-performance:1.26.1 && rubocop

# Shell / YAML
shellcheck $(git ls-files '*.sh') .githooks/pre-commit
shfmt -i 2 -ci -bn -d $(git ls-files '*.sh') .githooks/pre-commit
yamllint -c .yamllint.yml .github/
actionlint -ignore '"github\.(event\.pull_request\.head\.ref|head_ref)" is potentially untrusted'
```

## Gotchas (learned the hard way)

- **RuboCop is NOT in the site `Gemfile`.** Its transitive `parallel` dep needs Ruby >= 3.3, but `validate-content`/`unit`/`generate`/`deploy-preview`/the e2e web-server install the `Gemfile` via `ruby/setup-ruby` on **Ruby 3.2** — a `Gemfile` group made `bundle install` fail on 3.2 before any step ran. Install RuboCop standalone on Ruby 3.3. Keep dev-only linters out of the runtime `Gemfile`.
- **The full e2e suite enforces bespoke lint-tests** (`e2e/silent-catch-lint.test.js`, `e2e/parity-tag-lint.test.js`, `admin-css-banned-patterns`, etc.) that the per-file linters don't know about. A Prettier line-wrap can move a `// @parity-lint-allow:` annotation off its target line, or expose a latent silent `.catch(() => {})`. After a broad reformat, run the full e2e suite (or at least those `.test.js` files) — `e2e-tests.yml` runs the whole suite on every call with no diff-aware selection, so nothing skips these `.test.js` files on a reformat-only PR.
- **ESLint `detect-*-regexp` are warnings, not errors** (linear regexes over trusted input). Don't try to drive warnings to zero; the gate is errors-only.
- **`code-quality.yml` is advisory** (not in `main.json`). On failure it posts a gitleaks-scrubbed log as a PR comment via `.github/actions/post-failure-comment` — read that comment to debug, no Actions-log access needed.

## Adding a new language / file type

1. Pick the best-in-class linter; add it to the right manifest (npm `package.json` for JS-runtime tools; pip in `code-quality.yml` + the pre-commit hook for Python-family; binary download for compiled tools).
2. Create its config file (prefer a dedicated dotfile; only Python config lives in `pyproject.toml`).
3. Add a per-language branch to `scripts/lint-staged.sh` (tool-availability-gated so missing tools skip, never block) and a `changes`-gated step to `code-quality.yml`.
4. Document the toolchain row + any rule relaxations in AGENTS.md → "Code quality", and add the workflow trigger to the salient-paths table.
5. Relaxations get a comment explaining *why*; never disable a rule to hide a real bug.
