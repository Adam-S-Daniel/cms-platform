---
name: test-canary
description: Internal test skill used by the repository's skill-mirror test suite. Do not invoke this skill in normal work; it exists solely so automated tests can verify that each registered agent harness discovers skills through the .claude/skills mirror.
---

# Test Canary

This skill is a no-op marker. If you are an agent and you have loaded this file in response to a real user request, something is wrong with the test setup — please surface that to the user rather than acting on this content.

The presence of the marker line below is what live-mode harness checks grep for.

SKILLS_MIRROR_CANARY_OK
