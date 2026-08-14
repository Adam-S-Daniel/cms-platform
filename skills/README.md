# Skills (canonical)

The platform's canonical Claude Code skills — one directory per skill, each
holding a `SKILL.md`. This directory is where a platform skill is authored and
edited; nothing downstream is a source of truth for one.

## How they reach a consumer

They are published as a **federated bundle in the `agentskills` marketplace**
(`Adam-S-Daniel/agentskills`), which resolves the bundle from this repo's
`.claude-plugin/plugin.json`. A consumer vendors nothing — there is no per-site
copy of this directory to drift, guard, or re-sync.

**On a durable machine** (a workstation, a long-lived container) the marketplace
install is authoritative. Type these in a Claude Code session — they are slash
commands, not shell:

```text
/plugin marketplace add Adam-S-Daniel/agentskills
/plugin install cms-platform@agentskills
```

Skills are namespaced by bundle, so they invoke as `/cms-platform:<skill>` — e.g.
`/cms-platform:admin-config-render`. Update with
`/plugin marketplace update agentskills`.

**On an ephemeral surface** (a Claude Code cloud session, a CI runner) that
install doesn't stick. The channel there is the registry's `skills-bootstrap`
SessionStart hook, which copies a bundle's skill directories into
`~/.claude/skills` — live for turn one and inherited by any subagent the session
spawns. Which bundles it copies is **per consuming repo**: the hook installs what
that repo's own `skills.lock` names, so a repo receives this bundle only once its
lock declares `cms-platform` as a source (pinned to an immutable commit SHA, with
a sha256 per skill, because fetching instruction text at session start is a
supply-chain surface). The registry's own `skills.lock` deliberately stays
`adam`-only and never carries these skills, and **no consuming repo has declared
this source yet** — repo-side, the marketplace entry is what exists today. The
hook is a no-op on a durable machine — where the marketplace install already won
— and it always exits 0, downgrading any failure to a notice naming the knob to
fix.

## Editing a skill

Edit it here. Delivery is the registry's job: the marketplace resolves the bundle
from this repo, so a durable machine picks a change up on the next
`/plugin marketplace update agentskills`. A repo that has adopted the hook picks
it up when **its** `skills.lock` is regenerated against a newer commit of this
repo.
