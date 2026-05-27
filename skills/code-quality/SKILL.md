---
name: code-quality
description: Run, fix, and extend the repo's per-language lint + static-analysis + style toolchain (ESLint/Prettier, Ruff/Bandit/mypy, RuboCop, ShellCheck/shfmt, yamllint/actionlint, Stylelint, markdownlint). Use when a contributor asks to "lint", "format", "fix the lint errors", set up a linter for a new language, understand why a lint rule is disabled, add a check to CI or the pre-commit hook, or debug a code-quality.yml failure. Also use before opening a PR to confirm the lint gate is green.
---

# Code quality toolchain

Every language has a linter + static-analyzer + style tool, configured to pass at a strong-but-pragmatic strength. Checks run locally (`npm run lint` or each tool directly), as a staged-file pre-commit guard (`scripts/lint-staged.sh`), and in CI (`.github/workflows/code-quality.yml`). The canonical reference — toolchain table, every deliberate rule relaxation, and the RuboCop-out-of-Gemfile rationale — lives in **AGENTS.md → "Code quality"**. Read it before changing any lint config.

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
- **The full e2e suite enforces bespoke lint-tests** (`e2e/silent-catch-lint.test.js`, `e2e/parity-tag-lint.test.js`, `admin-css-banned-patterns`, etc.) that the per-file linters don't know about. A Prettier line-wrap can move a `// @parity-lint-allow:` annotation off its target line, or expose a latent silent `.catch(() => {})`. After a broad reformat, run the full e2e suite (or at least those `.test.js` files) — `select-specs.js` only runs them when base.js/config/package.json change.
- **ESLint `detect-*-regexp` are warnings, not errors** (linear regexes over trusted input). Don't try to drive warnings to zero; the gate is errors-only.
- **`code-quality.yml` is advisory** (not in `main.json`). On failure it posts a gitleaks-scrubbed log as a PR comment via `.github/actions/post-failure-comment` — read that comment to debug, no Actions-log access needed.

## Adding a new language / file type

1. Pick the best-in-class linter; add it to the right manifest (npm `package.json` for JS-runtime tools; pip in `code-quality.yml` + the pre-commit hook for Python-family; binary download for compiled tools).
2. Create its config file (prefer a dedicated dotfile; only Python config lives in `pyproject.toml`).
3. Add a per-language branch to `scripts/lint-staged.sh` (tool-availability-gated so missing tools skip, never block) and a `changes`-gated step to `code-quality.yml`.
4. Document the toolchain row + any rule relaxations in AGENTS.md → "Code quality", and add the workflow trigger to the salient-paths table.
5. Relaxations get a comment explaining *why*; never disable a rule to hide a real bug.
