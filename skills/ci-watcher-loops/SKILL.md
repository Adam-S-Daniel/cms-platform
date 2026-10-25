---
name: ci-watcher-loops
description: Patterns for setting up reliable agent self-feedback when waiting on long-running GitHub Actions workflows in this repo (cms-publish-loop-host, deploy-production, e2e matrix). The default temptation — `RUN=$(gh workflow run X && gh run list --jq ...)` chained into a polling `until` loop — silently breaks because both commands' stdout concatenate into the variable. Use the patterns here when chaining "wait for PR merge → trigger workflow → watch completion" or any multi-step CI poll. Trigger when the user asks to watch a workflow, set up a feedback loop, monitor PR completion, or any "let me know when X finishes" task that involves the gh CLI.
---

# CI watcher loops — making agent self-feedback reliable

Agents working on this repo routinely need to watch long-running workflows: `cms-publish-loop-host.yml` (~25 min happy path), `deploy-production.yml` (~5 min), the e2e matrix (~10 min). The natural shape is a chained watcher: *wait for some PR to merge → trigger a workflow_dispatch → watch the run → report result*.

The default approach has a subtle pitfall that breaks self-feedback silently. This skill captures the working patterns and the trap to avoid.

## When to invoke

- The user asks to watch / monitor / "tell me when" a long-running workflow finishes.
- You need to chain "wait for PR merge → trigger workflow → wait for run completion" automatically.
- You're setting up a feedback loop where you'll act on the workflow's result (re-trigger on failure, post a comment, surface a diagnosis).
- A previous watcher seems to have gone silent past its expected window — check whether it fell into the chained-capture pitfall below.

## The pitfall: `$(cmd1 && cmd2)` concatenates BOTH stdouts

```bash
# BROKEN — `gh workflow run` prints a URL line; `gh run list` prints the ID.
# Both go into $RUN. The watcher then runs `gh run view "$RUN"` with a
# multi-line value, which fails. The until-loop's status check never
# matches "completed", and the watcher polls forever.
RUN=$(gh workflow run <workflow>.yml --ref main && \
      sleep 5 && \
      gh run list --workflow=<workflow>.yml --limit 1 --json databaseId --jq '.[0].databaseId')

until [ "$(gh run view "$RUN" --json status --jq .status 2>/dev/null)" = "completed" ]; do
  sleep 60
done
```

`2>/dev/null` makes the bug invisible — the status check fails silently every poll, the loop sleeps and retries. The watcher LOOKS healthy (it polls every minute) but never exits. Hours can pass before the user notices the silence.

## The fix: split the assignment

```bash
# CORRECT — capture only the dispatch's own output. Since gh 2.87.0, `gh workflow run`
# prints the created run's URL (non-TTY: that URL alone), so the run id comes from
# the dispatch itself: no second read, and no race with other runs of the workflow.
SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # only for the fallback below
OUT=$(gh workflow run <workflow>.yml --ref main)
RUN=$(sed -n 's#^https://.*/actions/runs/\([0-9][0-9]*\)$#\1#p' <<<"$OUT")

# Fallback, only when no run URL was printed (gh < 2.87.0, or a server that returns
# no run details). Never `gh run list --limit 1` bare: it returns the newest run of
# the workflow, which can be another actor's. Filter to this dispatch, and accept
# only an unambiguous match — an empty RUN means "not found", not "guess".
if [ -z "$RUN" ]; then
  sleep 5
  RUN=$(gh run list --workflow=<workflow>.yml --event workflow_dispatch --branch main \
          --user "$(gh api user --jq .login)" --created ">=$SINCE" \
          --limit 2 --json databaseId --jq 'if length == 1 then .[0].databaseId else empty end')
fi
[ -n "$RUN" ] || { echo "no run id for this dispatch" >&2; exit 1; }

until [ "$(gh run view "$RUN" --json status --jq .status 2>/dev/null)" = "completed" ]; do
  sleep 60
done
```

The fallback still cannot tell apart two dispatches of the same workflow by the same account inside the window (it then returns nothing rather than the wrong run); upgrade gh rather than lean on it.

**Pre-flight check**: before wiring a chain into a long polling loop, `echo "$RUN"` and confirm it's a single value of the expected shape. Five seconds at write time saves hours of silent failure.

## Prefer the `Monitor` tool over `Bash run_in_background` for multi-step watchers

Single-event watchers (`run_in_background` + an `until` loop that exits on success) get one final notification. That's fine for "tell me when X finishes."

Multi-step watchers (PR merge → trigger → watch) benefit from per-step events so you see WHERE a chain is stuck if it goes silent:

```bash
# Monitor command — each `echo` is a notification:
while true; do
  s=$(gh pr view 232 --json state --jq .state 2>/dev/null || echo "")
  if [ "$s" = "MERGED" ]; then echo "STEP1_MERGED"; break; fi
  sleep 60
done
OUT=$(gh workflow run cms-publish-loop-host.yml --ref main 2>/dev/null)
RUN=$(sed -n 's#^https://.*/actions/runs/\([0-9][0-9]*\)$#\1#p' <<<"$OUT")
# No URL (gh < 2.87.0)? Use the filtered fallback from "The fix" here.
if [ -z "$RUN" ]; then echo "STEP2_NO_RUN_ID"; exit 1; fi
echo "STEP2_TRIGGERED run=$RUN"
while true; do
  s=$(gh run view "$RUN" --json status --jq .status 2>/dev/null || echo "")
  if [ "$s" = "completed" ]; then
    c=$(gh run view "$RUN" --json conclusion --jq .conclusion 2>/dev/null)
    echo "STEP3_DONE run=$RUN conclusion=$c"
    break
  fi
  sleep 60
done
```

If STEP1 fires but STEP2 never does, you know the trigger broke. If STEP2 fires but STEP3 never does, you know the run is wedged (or the watcher is). Without per-step events, you'd just have "the watcher hasn't reported anything" and no way to localise the fault.

In Claude Code, the `Monitor` running this chain expires after 30 min at most, so for a host loop (over an hour per iteration) expect STEP3 to come from a re-armed watcher — see [Claude Code watchers have a time limit](#claude-code-watchers-have-a-time-limit--size-them-and-re-arm-them).

## Claude Code watchers have a time limit — size them, and re-arm them

This section is about Claude Code's own tools (`Bash` with `run_in_background`, and `Monitor`). Another agent harness has its own background-command limits, or none; check that harness's documentation rather than applying these numbers to it. In Claude Code, both watcher tools stop on their own clock, whether or not the run they watch has finished:

- **`Bash run_in_background`**: stops at its `timeout` — default 30 min, max 2 h (since Claude Code [2.1.285](https://github.com/anthropics/claude-code/releases/tag/v2.1.285)). Claude is notified when it is stopped.
- **`Monitor`**: expires after `timeout_ms` — default 5 min, **capped at 30 min** (a larger value is capped; the start notice says "expires in 30m").

A host-loop run (`cms-publish-loop-host.yml`, `timeout-minutes: 150`, over an hour per iteration) can outlast a single `Monitor` and even the 2 h Bash maximum, so its watch spans several watchers.

- **Always pass `timeout` explicitly** on a background watcher, sized past the run's expected duration (e.g. `timeout: 7200000` for anything longer than ~25 min). For a `Monitor`, pass `timeout_ms: 1800000` and expect to re-arm.
- **A stop notice is not a completion.** When a watcher is stopped at its limit (Bash: status `killed`, "stopped after reaching its background time limit"; Monitor: "expired after 30m"), the watched run may still be going, and the watcher's trailing `echo` never ran. Re-query before concluding anything: `gh run view "$RUN" --json status,conclusion`. Re-arm if it is still running.
- **Re-arm a single-run watcher, not the whole chain.** Capture `RUN` once (see [the fix](#the-fix-split-the-assignment)), then re-arm a watcher that polls only that `RUN`. Don't re-dispatch, and don't re-run the STEP1/STEP2 parts of the multi-step example.

```bash
# Re-armable single-run watcher — RUN was captured once, earlier.
# Start with Bash run_in_background + timeout: 7200000; on the stop notice,
# re-check status, and start this same watcher again if still running.
until [ "$(gh run view "$RUN" --json status --jq .status 2>/dev/null)" = "completed" ]; do
  sleep 60
done
echo "DONE run=$RUN conclusion=$(gh run view "$RUN" --json conclusion --jq .conclusion 2>/dev/null)"
```

Verified 2026-09-30 on Claude Code 2.1.285: a default-timeout Bash watcher (`sleep 7200`) was killed at ~30 min with output ending `[killed]`, one with `timeout: 7200000` (`sleep 9000`) was killed at 2 h, and a 60-min `Monitor` expired at 30 min.

## When poll intervals matter

- Remote API polling (`gh run view`, `gh pr view`): 60 s is the right floor. GitHub's secondary rate-limit will start throttling at ~80 reqs/min for a single token, and there's no value in tighter polling for a workflow that takes ≥5 min.
- Local file checks: 0.5–1 s is fine.
- Compounded polling (poll-A then poll-B in series): use 60 s for each — the overhead is per-iteration, not per-call.

## What NOT to do

- **Don't use `gh run watch`** in an unattended watcher: it prints progress to stdout but doesn't exit until the run finishes, making it hard to chain into the rest of a watcher.
- **Don't poll faster than the 60 s floor above** against the GitHub API — a watcher shares its token's rate limit with the rest of the agent's work.
- **Don't rely on `gh workflow run`'s exit code** to tell you the run started. It only confirms the dispatch was accepted; the run might be queued, skipped (recursion guard), or rejected. Take the run id from the URL it prints (gh ≥ 2.87.0) — that is the run it created. Without a URL, find the run with the filtered `gh run list` in [the fix](#the-fix-split-the-assignment) after a 5 – 8 s wait, never a bare `gh run list --limit 1`, which can return another actor's run.
- **Don't put critical state in chained `$(...)` captures** without testing first. Variable pollution from `&&`-chained commands is the #1 cause of silent watcher hangs in this repo.

## Reference

- The pitfall surfaced on 2026-05-06 while watching `cms-publish-loop-host.yml` after fixes #222 + #227 landed; the chained-capture bug left an agent blind for ~30 minutes.
- Tooling: `Monitor` (preferred for multi-step), `Bash run_in_background` (preferred for single-event), `TaskStop` to kill a hung watcher. In Claude Code, both watcher tools stop at a time limit — see [Claude Code watchers have a time limit](#claude-code-watchers-have-a-time-limit--size-them-and-re-arm-them).
