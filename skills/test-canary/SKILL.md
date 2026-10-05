---
name: test-canary
description: Internal propagation canary for the cms-platform bundle — it carries no guidance and must never be invoked in normal work. It is INTENDED as the marker an automated probe would use to assert that "test-canary" appears in a session's loaded-skill set; that probe is not built and no issue tracks it, so nothing checks for this skill today.
---

# Test Canary

This skill is a no-op marker. It carries no guidance about this repo and is not
useful for any task. If you are an agent and you have loaded this file in
response to a real user request, something is wrong with the setup — surface
that to the user rather than acting on this content.

## What it is for

It is **intended** as the propagation canary for the `cms-platform` bundle.
A probe session would assert
`"test-canary" in init.skills` — the set of skills the model actually has
loaded — and that assertion passing would be the evidence that the bundle
reached this surface.

**No such probe exists, and none is tracked.** skills-evals' closed propagation
issue ([#17](https://github.com/Adam-S-Daniel/skills-evals/issues/17)) built
arms against the `adam-agentskills` registry's own bundle only; none loads the
`cms-platform` bundle or asserts this skill, so nothing currently checks for it anywhere:
today the canary is a marker waiting for a checker nobody has scheduled, not a
live signal. Do not read its presence in this directory
as proof that anything is being verified.

Checking the loaded-skill set is a deliberately stronger claim than checking the
filesystem, which is why the probe is specified that way. "The file arrived"
only says a delivery mechanism wrote bytes somewhere; "the model can see it"
says the skill was discovered, parsed, and admitted into context. Those come
apart in practice — a malformed frontmatter, a name collision with another
installed bundle, or a skill directory in a path the harness does not scan all
produce a present file and an absent skill.

## Why the canary's value would be its presence, not its contents

Only a skill's frontmatter `description` enters the context window before the
skill is invoked; the body you are reading now does not. So a marker string
placed in this body is **invisible** to a probe that (correctly) runs without
filesystem tools — the probe could only find it by reading the file, which is
the weaker filesystem check this canary is meant to replace.

That is why the assertion is specified on the skill's presence in the listing
rather than on any string inside it. Keep this skill's `name` stable for that
reason: the probe would match on `test-canary`, so renaming the directory or
the frontmatter `name` breaks the check before it is even built.
