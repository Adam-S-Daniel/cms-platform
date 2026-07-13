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

## Repo-local skills (opt out of platform management)

A site can keep skills that are specific to it and should NOT be managed by the
platform (e.g. adamdaniel.ai's `embeddable-tool-pages`). Mark such a skill by
dropping an empty `.repo-local` file in its directory:

```
.claude/skills/embeddable-tool-pages/
├── SKILL.md
└── .repo-local        # ← this skill is site-owned; the sync leaves it alone
```

The `skills-sync` reusable excludes any `.repo-local`-marked skill from both the
transfer (never overwritten) and the `--delete` sweep (never removed). Every
other skill stays platform-authoritative, so a skill removed from this canonical
set is still deleted from the site — a marker is what distinguishes "site-owns
this" from "the platform dropped this, delete it." The drift-guard already
ignores site-only skills (a skill with no platform counterpart is never flagged),
so a `.repo-local` skill needs no byte-match with the platform.
