# Skills (canonical)

The platform's canonical Claude Code skills. Sites receive them via the
`skills-sync` reusable workflow, which rsyncs this directory into the site's
`.claude/skills/` and opens a PR when they drift (platform-authoritative).

This is the transport the design calls for — **not** adamdaniel.ai's
`skills-mirror.yml`, which is a *local* `.agents/skills` ↔ `.claude/skills`
structural verifier, not a cross-repo sync.

Improvements made in a site's `.claude/skills` are caught by the drift-guard
(see `.github/workflows`) and routed back here as a PR.
