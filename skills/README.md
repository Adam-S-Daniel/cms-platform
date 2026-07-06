# Skills (canonical)

The platform's canonical Claude Code skills. Sites receive them via the
`skills-sync` reusable workflow, which rsyncs this directory into the site's
`.claude/skills/` and opens a PR when they drift (platform-authoritative).

This is the transport the design calls for. adamdaniel.ai's old
`skills-mirror.yml` — a *local* `.agents/skills` ↔ `.claude/skills` structural
verifier, not a cross-repo sync — has since been REMOVED (P7, v0.1.46),
superseded by the platform's centralized `dev-hooks-sync.yml` guard.

Improvements made in a site's `.claude/skills` are caught by the drift-guard
(see `.github/workflows`) and routed back here as a PR.
