#!/usr/bin/env python3
"""
Replay of the scheduled-run health audit's tracking-issue lifecycle under
alternative close rules, over 30 days of real Actions runs from the audit's
public callers. The decision and every number it produced are recorded in
docs/HEALTH-AUDIT-CLOSE-RULE.md; this file and runs.json are its evidence.

Reads runs.json beside this file and never touches the network while it
exists. Delete runs.json to re-fetch (read-only `gh api` GETs). The published
runs.json keeps only lanes (workflow file, event) that had at least one failed
run, which is every lane any rule reads, and omits the one private caller.

Exit 0 means every verifier passed. Any mismatch exits 1.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_FILE = os.path.join(HERE, "runs.json")

# Adam-S-Daniel/repo-settings also calls the audit but is PRIVATE, so its runs
# are not published. Excluding it changes no issue count, close time or
# hidden-failure count below.
REPOS = [
    "Adam-S-Daniel/adamdaniel.ai",
    "jodidaniel/jodidaniel.com",
    "Adam-S-Daniel/_agent-guidance",
    "Adam-S-Daniel/skills-evals",
    "Adam-S-Daniel/fastmail-actions",
    "Adam-S-Daniel/GHA-bench",
    "Adam-S-Daniel/claude-memory-map",
    "Adam-S-Daniel/agentskills",
    "Adam-S-Daniel/cms-platform",
]

WINDOW_START = "2026-08-13T00:00:00Z"
FETCH_END = "2026-09-16T00:00:00Z"  # covers through the last audit instant (2026-09-15T13:00Z or 15:30Z)
BAD_CONCLUSIONS = {"failure", "startup_failure", "timed_out"}
GOOD_CONCLUSIONS = {"success"}

PAGE_CAP = 20
# GitHub's Actions runs-list endpoint silently truncates pagination around 1000
# results (reports a higher total_count but page 11+ comes back empty). Any
# sub-range whose total_count exceeds this is split in half and re-fetched.
SPLIT_THRESHOLD = 900
MAX_SPLIT_DEPTH = 6

ISO_FMT = "%Y-%m-%dT%H:%M:%SZ"


def _parse(s):
    return datetime.strptime(s, ISO_FMT).replace(tzinfo=timezone.utc)


def _fmt(dt):
    return dt.strftime(ISO_FMT)


def gh_api_json(url):
    """Run `gh api <url>` and return parsed JSON, or None on 404."""
    proc = subprocess.run(
        ["gh", "api", url],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.strip()
        if "HTTP 404" in stderr or "Not Found" in stderr:
            return {"__404__": True, "__stderr__": stderr}
        raise RuntimeError(f"gh api failed for {url}: {stderr}")
    return json.loads(proc.stdout)


def _lane_url_base(repo, event, branch, start_iso, end_iso):
    url = f"repos/{repo}/actions/runs?event={event}&created={start_iso}..{end_iso}"
    if branch:
        url += f"&branch={branch}"
    return url


def _fetch_range_raw(repo, event, branch, start_dt, end_dt, depth, cap_hit_flag):
    """Fetch raw workflow_run dicts (unfiltered) for [start_dt, end_dt], splitting
    the date range in half whenever total_count exceeds SPLIT_THRESHOLD (works
    around the API's silent ~1000-result pagination truncation). Returns None on
    404 (repo not visible)."""
    start_iso, end_iso = _fmt(start_dt), _fmt(end_dt)
    meta_url = _lane_url_base(repo, event, branch, start_iso, end_iso) + "&per_page=1&page=1"
    meta = gh_api_json(meta_url)
    if isinstance(meta, dict) and meta.get("__404__"):
        return None
    total_count = meta.get("total_count", 0)
    if total_count == 0:
        return []
    if total_count > SPLIT_THRESHOLD and depth < MAX_SPLIT_DEPTH and (end_dt - start_dt) > timedelta(hours=1):
        mid = start_dt + (end_dt - start_dt) / 2
        left = _fetch_range_raw(repo, event, branch, start_dt, mid, depth + 1, cap_hit_flag)
        if left is None:
            return None
        right = _fetch_range_raw(repo, event, branch, mid, end_dt, depth + 1, cap_hit_flag)
        if right is None:
            return None
        merged = {r["id"]: r for r in left + right}
        return list(merged.values())

    # Within threshold (or split budget exhausted): paginate normally.
    collected = []
    for page in range(1, PAGE_CAP + 1):
        url = _lane_url_base(repo, event, branch, start_iso, end_iso) + f"&per_page=100&page={page}"
        data = gh_api_json(url)
        if isinstance(data, dict) and data.get("__404__"):
            return None
        page_runs = data.get("workflow_runs", [])
        collected.extend(page_runs)
        if len(page_runs) < 100:
            break
        if page == PAGE_CAP:
            cap_hit_flag.append(True)
    if len(collected) < total_count:
        # Split budget exhausted but still truncated relative to total_count.
        cap_hit_flag.append(True)
    return collected


def fetch_lane(repo, event, branch=None):
    """Fetch all completed runs for one (repo, event[, branch]) lane over the
    full window, using date-range splitting to avoid silent API truncation."""
    cap_hit_flag = []
    raw = _fetch_range_raw(
        repo, event, branch, _parse(WINDOW_START), _parse(FETCH_END), 0, cap_hit_flag
    )
    if raw is None:
        return None, False
    runs = []
    seen_ids = set()
    for r in raw:
        if r["id"] in seen_ids:
            continue
        seen_ids.add(r["id"])
        if r.get("status") != "completed":
            continue
        runs.append({
            "id": r["id"],
            "path": r["path"],
            "event": r["event"],
            "conclusion": r.get("conclusion"),
            "ts": r.get("run_started_at") or r.get("created_at"),
            "done": r.get("updated_at"),
        })
    return runs, bool(cap_hit_flag)


def fetch_all():
    result = {}
    not_visible = []
    cap_hit_repos = []
    for repo in REPOS:
        print(f"fetching {repo} ...", file=sys.stderr)
        db = gh_api_json(f"repos/{repo}")
        if isinstance(db, dict) and db.get("__404__"):
            not_visible.append(repo)
            continue
        default_branch = db["default_branch"]

        sched_runs, sched_cap = fetch_lane(repo, "schedule")
        push_runs, push_cap = fetch_lane(repo, "push", branch=default_branch)
        if sched_runs is None or push_runs is None:
            not_visible.append(repo)
            continue
        if sched_cap or push_cap:
            cap_hit_repos.append(repo)

        result[repo] = {
            "default_branch": default_branch,
            "runs": sched_runs + push_runs,
        }
    return {"repos": result, "not_visible": not_visible, "cap_hit": cap_hit_repos}


def _trim_and_write(data, path):
    """Keep only runs whose lane (basename(path), event) had at least one BAD
    run in that repo's data (no rule below reads a lane with no BAD run), then
    write one run object per line so diffs and scanners work line by line."""
    repos = data["repos"]
    repo_names = list(repos.keys())
    trimmed_repos = {}
    lines = ["{", '"repos": {']
    for i, repo in enumerate(repo_names):
        rd = repos[repo]
        bad_lanes = set()
        for r in rd["runs"]:
            if r["conclusion"] in BAD_CONCLUSIONS:
                bad_lanes.add(lane_key(r["path"], r["event"]))
        runs = [r for r in rd["runs"] if lane_key(r["path"], r["event"]) in bad_lanes]
        trimmed_repos[repo] = {"default_branch": rd["default_branch"], "runs": runs}
        lines.append(json.dumps(repo) + ': {"default_branch": '
                     + json.dumps(rd["default_branch"]) + ', "runs": [')
        for j, run in enumerate(runs):
            comma = "," if j < len(runs) - 1 else ""
            lines.append(json.dumps(run, separators=(", ", ": ")) + comma)
        lines.append("]}," if i < len(repo_names) - 1 else "]}")
    lines.append("},")
    not_visible = data.get("not_visible", [])
    cap_hit = data.get("cap_hit", [])
    lines.append('"not_visible": ' + json.dumps(not_visible) + ",")
    lines.append('"cap_hit": ' + json.dumps(cap_hit))
    lines.append("}")
    trimmed = {"repos": trimmed_repos, "not_visible": not_visible, "cap_hit": cap_hit}
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    with open(path) as f:
        assert json.load(f) == trimmed, "runs.json round-trip mismatch after trim"
    return trimmed


def load_or_fetch():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE) as f:
            return json.load(f)
    data = fetch_all()
    return _trim_and_write(data, DATA_FILE)


# ---------------------------------------------------------------------------
# Simulation
# ---------------------------------------------------------------------------

def parse_ts(s):
    return datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def lane_key(path, event):
    return (os.path.basename(path), event)


def audit_instants(hour=13, minute=0):
    """31 daily audit instants, 2026-08-16 through 2026-09-15, at hour:minute:00Z."""
    instants = []
    t = datetime(2026, 8, 16, hour, minute, 0, tzinfo=timezone.utc)
    end = datetime(2026, 9, 15, hour, minute, 0, tzinfo=timezone.utc)
    while t <= end:
        instants.append(t)
        t += timedelta(days=1)
    return instants


def recovered(key, t, runs_by_key, k=1):
    """key recovered at t iff the newest k visible GOOD-or-BAD runs of that key
    (visible meaning done <= t) are all GOOD and all newer (by ts) than the
    key's newest visible BAD run."""
    candidates = [r for r in runs_by_key.get(key, [])
                  if r["conclusion"] in BAD_CONCLUSIONS or r["conclusion"] in GOOD_CONCLUSIONS]
    visible = [r for r in candidates if parse_ts(r["done"]) <= t]
    if not visible:
        return False
    visible_sorted = sorted(visible, key=lambda r: parse_ts(r["ts"]), reverse=True)
    bad_visible = [r for r in visible_sorted if r["conclusion"] in BAD_CONCLUSIONS]
    newest_bad_ts = max((parse_ts(r["ts"]) for r in bad_visible), default=None)
    if newest_bad_ts is None:
        return True  # no bad run ever visible -> vacuously recovered (shouldn't be hit by callers)
    top_k = visible_sorted[:k]
    if len(top_k) < k:
        return False
    return all(r["conclusion"] in GOOD_CONCLUSIONS and parse_ts(r["ts"]) > newest_bad_ts for r in top_k)


class RuleState:
    """State machine for A, B2, B1, B1k2: reported set resets when the issue closes."""
    def __init__(self):
        self.open = False
        self.reported = set()
        self.filed = 0
        self.open_audits = 0
        self.episode_bad_max_ts = None
        self.closes = []  # list of (episode_newest_bad_ts, close_audit_t)

    def step(self, t, findings):
        if findings:
            if not self.open:
                self.open = True
                self.filed += 1
                self.reported = set(r["id"] for r in findings)
            else:
                for r in findings:
                    self.reported.add(r["id"])
            newest = max(parse_ts(r["ts"]) for r in findings)
            if self.episode_bad_max_ts is None or newest > self.episode_bad_max_ts:
                self.episode_bad_max_ts = newest
        else:
            if self.open:
                self.open = False
                self.closes.append((self.episode_bad_max_ts, t))
                self.episode_bad_max_ts = None
                self.reported = set()
        if self.open:
            self.open_audits += 1


class B3State:
    """B3 / B3k2: reported is monotonic (never reset on close). Every audit:
    fresh = findings - reported; fresh nonempty files (if closed) or comments
    (if open), and is added to reported either way. Then, independently, if
    the issue is open and every (basename,event) key with a BAD run in the
    current window is recovered, close (possibly same audit as the file)."""
    def __init__(self):
        self.open = False
        self.reported = set()
        self.filed = 0
        self.same_audit_file_close = 0
        self.open_audits = 0
        self.episode_bad_max_ts = None
        self.closes = []

    def step(self, t, findings, recovered_fn):
        findings_ids = set(r["id"] for r in findings)
        fresh_ids = findings_ids - self.reported
        filed_this_audit = False
        if fresh_ids:
            if not self.open:
                self.open = True
                self.filed += 1
                filed_this_audit = True
            self.reported |= fresh_ids
        if self.open and findings:
            newest = max(parse_ts(r["ts"]) for r in findings)
            if self.episode_bad_max_ts is None or newest > self.episode_bad_max_ts:
                self.episode_bad_max_ts = newest
        if self.open:
            keys = set(lane_key(r["path"], r["event"]) for r in findings)
            if all(recovered_fn(k) for k in keys):  # vacuously True if keys is empty
                self.closes.append((self.episode_bad_max_ts, t))
                if filed_this_audit:
                    self.same_audit_file_close += 1
                self.open = False
                self.episode_bad_max_ts = None
        if self.open:
            self.open_audits += 1


def median_close_hours(closes):
    hrs = [(ct - bt).total_seconds() / 3600.0 for bt, ct in closes if bt is not None]
    if not hrs:
        return None
    hrs.sort()
    n = len(hrs)
    mid = n // 2
    return hrs[mid] if n % 2 == 1 else (hrs[mid - 1] + hrs[mid]) / 2.0


def simulate_repo(runs, audit_hour=13, audit_minute=0):
    runs_by_key = {}
    for r in runs:
        k = lane_key(r["path"], r["event"])
        runs_by_key.setdefault(k, []).append(r)

    instants = audit_instants(audit_hour, audit_minute)

    A = RuleState()
    B2 = RuleState()
    B1 = RuleState()
    B1k2 = RuleState()
    B3 = B3State()
    B3k2 = B3State()

    ever_in_findings_B1 = set()
    ever_in_findings_B1k2 = set()
    ever_in_window_ids = set()

    all_bad_runs = [r for r in runs if r["conclusion"] in BAD_CONCLUSIONS]

    for t in instants:
        window_start = t - timedelta(hours=48)
        visible_bad_in_window = [
            r for r in runs
            if r["conclusion"] in BAD_CONCLUSIONS
            and parse_ts(r["done"]) <= t
            and window_start <= parse_ts(r["ts"]) <= t
        ]
        for r in visible_bad_in_window:
            ever_in_window_ids.add(r["id"])

        # Rule A
        A.step(t, visible_bad_in_window)

        # Rule B2: findings same as A; close iff open and every key-with-finding recovered (k=1)
        findings = visible_bad_in_window
        if findings:
            if not B2.open:
                B2.open = True
                B2.filed += 1
                B2.reported = set(r["id"] for r in findings)
            else:
                for r in findings:
                    B2.reported.add(r["id"])
            newest = max(parse_ts(r["ts"]) for r in findings)
            if B2.episode_bad_max_ts is None or newest > B2.episode_bad_max_ts:
                B2.episode_bad_max_ts = newest
        if B2.open:
            keys_with_finding = set(lane_key(r["path"], r["event"]) for r in findings)
            if all(recovered(k, t, runs_by_key, k=1) for k in keys_with_finding):
                B2.open = False
                B2.closes.append((B2.episode_bad_max_ts, t))
                B2.episode_bad_max_ts = None
                B2.reported = set()
        if B2.open:
            B2.open_audits += 1

        # Rule B1: findings = visible BAD in window whose key NOT recovered (k=1)
        findings_B1 = [r for r in visible_bad_in_window
                       if not recovered(lane_key(r["path"], r["event"]), t, runs_by_key, k=1)]
        for r in findings_B1:
            ever_in_findings_B1.add(r["id"])
        B1.step(t, findings_B1)

        # Rule B1k2: findings = visible BAD in window whose key NOT recovered (k=2)
        findings_B1k2 = [r for r in visible_bad_in_window
                         if not recovered(lane_key(r["path"], r["event"]), t, runs_by_key, k=2)]
        for r in findings_B1k2:
            ever_in_findings_B1k2.add(r["id"])
        B1k2.step(t, findings_B1k2)

        # Rule B3 / B3k2
        B3.step(t, visible_bad_in_window, lambda key: recovered(key, t, runs_by_key, k=1))
        B3k2.step(t, visible_bad_in_window, lambda key: recovered(key, t, runs_by_key, k=2))

    never_in_window = [r for r in all_bad_runs if r["id"] not in ever_in_window_ids]
    absorbed_B1_inwin = [r for r in all_bad_runs
                         if r["id"] in ever_in_window_ids and r["id"] not in ever_in_findings_B1]
    absorbed_B1k2_inwin = [r for r in all_bad_runs
                           if r["id"] in ever_in_window_ids and r["id"] not in ever_in_findings_B1k2]
    absorbed_B3_inwin = [r for r in all_bad_runs
                         if r["id"] in ever_in_window_ids and r["id"] not in B3.reported]
    absorbed_B3k2_inwin = [r for r in all_bad_runs
                           if r["id"] in ever_in_window_ids and r["id"] not in B3k2.reported]

    return {
        "A": A, "B2": B2, "B1": B1, "B1k2": B1k2, "B3": B3, "B3k2": B3k2,
        "median_close_A": median_close_hours(A.closes),
        "median_close_B1": median_close_hours(B1.closes),
        "median_close_B3": median_close_hours(B3.closes),
        "median_close_B3k2": median_close_hours(B3k2.closes),
        "never_in_window": never_in_window,
        "absorbed_B1_inwin": absorbed_B1_inwin,
        "absorbed_B1k2_inwin": absorbed_B1k2_inwin,
        "absorbed_B3_inwin": absorbed_B3_inwin,
        "absorbed_B3k2_inwin": absorbed_B3k2_inwin,
        "ever_in_window_ids": ever_in_window_ids,
    }


def run_verifier(runs, audit_hour=13, audit_minute=0):
    """Verify skills-evals Rule A behavior matches known reality (issue #150)."""
    ok = True
    msgs = []
    state_open = False
    filed_dates = []
    close_dates = []
    trace = {}
    for t in audit_instants(audit_hour, audit_minute):
        window_start = t - timedelta(hours=48)
        visible_bad_in_window = [
            r for r in runs
            if r["conclusion"] in BAD_CONCLUSIONS
            and parse_ts(r["done"]) <= t
            and window_start <= parse_ts(r["ts"]) <= t
        ]
        if visible_bad_in_window:
            if not state_open:
                state_open = True
                filed_dates.append(t)
        else:
            if state_open:
                state_open = False
                close_dates.append(t)
        trace[t] = state_open

    d_0909 = datetime(2026, 9, 9, audit_hour, audit_minute, 0, tzinfo=timezone.utc)
    d_0915 = datetime(2026, 9, 15, audit_hour, audit_minute, 0, tzinfo=timezone.utc)
    open_at_0915 = trace[d_0915]
    first_filed_0909 = d_0909 in filed_dates
    continuously_open = all(trace[t] for t in trace if d_0909 <= t <= d_0915)

    if not open_at_0915:
        ok = False
        msgs.append("issue NOT open at last audit")
    if not first_filed_0909:
        ok = False
        msgs.append("issue NOT first filed at 2026-09-09 audit; filed on: "
                     + ", ".join(d.strftime("%Y-%m-%d") for d in filed_dates))
    if not continuously_open:
        ok = False
        msgs.append("issue NOT continuously open 09-09..09-15")

    return ok, msgs, filed_dates, close_dates


INCIDENT_RUN_IDS = {
    32252738313, 32253734806, 32254971677, 32256172165,
    32256735954, 32257234621, 32257724431, 32260987609,
}
INCIDENT_REPO = "Adam-S-Daniel/adamdaniel.ai"


def main():
    data = load_or_fetch()
    repos_data = data["repos"]
    not_visible = data.get("not_visible", [])
    cap_hit = data.get("cap_hit", [])

    schedules = [(13, 0), (15, 30)]
    # results[(hour,minute)][repo] = (runs, sim)
    results = {sch: {} for sch in schedules}
    for repo, rd in repos_data.items():
        runs = rd["runs"]
        for hour, minute in schedules:
            results[(hour, minute)][repo] = (runs, simulate_repo(runs, hour, minute))

    exit_code = 0
    fail_reasons = []

    # --- Verifier: skills-evals Rule A trace, at 13:00 ---
    se_key = "Adam-S-Daniel/skills-evals"
    print("=== VERIFIER (13:00) ===")
    if se_key not in results[(13, 0)]:
        print("skills-evals: FAIL (repo not visible)")
        exit_code = 1
        fail_reasons.append("skills-evals not visible")
    else:
        runs, sim = results[(13, 0)][se_key]
        ok, msgs, filed_dates, close_dates = run_verifier(runs, 13, 0)
        print(f"skills-evals A trace: {'PASS' if ok else 'FAIL'}")
        print(f"  filed_dates: {[d.strftime('%Y-%m-%d') for d in filed_dates]}")
        print(f"  close_dates: {[d.strftime('%Y-%m-%d') for d in close_dates]}")
        for m in msgs:
            print(f"  - {m}")
        if not ok:
            exit_code = 1
            fail_reasons.append("skills-evals A trace check failed")
        d_0914 = datetime(2026, 9, 14, 13, 0, 0, tzinfo=timezone.utc)
        b1_closed_0914 = any(ct == d_0914 for (_, ct) in sim["B1"].closes)
        print(f"  B1 closed at 2026-09-14T13:00Z: {b1_closed_0914}")

    # --- Verifier: totals at 13:00 ---
    tot_filed_A_1300 = sum(sim["A"].filed for _, sim in results[(13, 0)].values())
    tot_filed_B1_1300 = sum(sim["B1"].filed for _, sim in results[(13, 0)].values())
    tot_absorbed_B1_inwin_1300 = sum(len(sim["absorbed_B1_inwin"]) for _, sim in results[(13, 0)].values())
    print(f"total filed_A@13:00={tot_filed_A_1300} (expect 13)")
    print(f"total filed_B1@13:00={tot_filed_B1_1300} (expect 13)")
    print(f"total absorbed_B1_inwin@13:00={tot_absorbed_B1_inwin_1300} (expect 28)")
    if tot_filed_A_1300 != 13:
        exit_code = 1
        fail_reasons.append(f"filed_A@13:00 = {tot_filed_A_1300}, expected 13")
    if tot_filed_B1_1300 != 13:
        exit_code = 1
        fail_reasons.append(f"filed_B1@13:00 = {tot_filed_B1_1300}, expected 13")
    if tot_absorbed_B1_inwin_1300 != 28:
        exit_code = 1
        fail_reasons.append(f"absorbed_B1_inwin@13:00 = {tot_absorbed_B1_inwin_1300}, expected 28")

    # --- Verifier: B3 in-window absorbed must be 0, both schedules ---
    for hour, minute in schedules:
        tot_b3_absorbed = sum(len(sim["absorbed_B3_inwin"]) for _, sim in results[(hour, minute)].values())
        print(f"B3 in-window absorbed @ {hour:02d}:{minute:02d} = {tot_b3_absorbed} (expect 0)")
        if tot_b3_absorbed != 0:
            exit_code = 1
            fail_reasons.append(f"B3 in-window absorbed @ {hour:02d}:{minute:02d} = {tot_b3_absorbed}, expected 0")

    print("\n=== not visible (404) ===")
    for r in not_visible:
        print(r)
    print("\n=== page cap hit ===")
    for r in cap_hit:
        print(r)

    # --- Per-repo detail, both schedules ---
    for hour, minute in schedules:
        print(f"\n=== per-repo detail @ {hour:02d}:{minute:02d} ===")
        for repo, (runs, sim) in results[(hour, minute)].items():
            n_sched = sum(1 for r in runs if r["event"] == "schedule")
            n_push = sum(1 for r in runs if r["event"] == "push")
            print(json.dumps({
                "repo": repo, "sched_runs_in_failing_lanes": n_sched, "push_runs_in_failing_lanes": n_push,
                "filed_A": sim["A"].filed, "filed_B1": sim["B1"].filed,
                "filed_B3": sim["B3"].filed, "filed_B3k2": sim["B3k2"].filed,
                "same_audit_file_close_B3": sim["B3"].same_audit_file_close,
                "same_audit_file_close_B3k2": sim["B3k2"].same_audit_file_close,
                "median_close_A_hrs": sim["median_close_A"],
                "median_close_B1_hrs": sim["median_close_B1"],
                "median_close_B3_hrs": sim["median_close_B3"],
                "median_close_B3k2_hrs": sim["median_close_B3k2"],
                "never_in_window_count": len(sim["never_in_window"]),
                "never_in_window_names": sorted(set(os.path.basename(r["path"]) for r in sim["never_in_window"])),
                "absorbed_B1_inwin_count": len(sim["absorbed_B1_inwin"]),
                "absorbed_B1_inwin_names": sorted(set(os.path.basename(r["path"]) for r in sim["absorbed_B1_inwin"])),
                "absorbed_B1k2_inwin_count": len(sim["absorbed_B1k2_inwin"]),
                "absorbed_B1k2_inwin_names": sorted(set(os.path.basename(r["path"]) for r in sim["absorbed_B1k2_inwin"])),
            }))

    # --- Totals per schedule ---
    for hour, minute in schedules:
        tot = {}
        for rule in ["A", "B1", "B3", "B3k2"]:
            filed = sum(sim[rule].filed for _, sim in results[(hour, minute)].values())
            sacf = sum(getattr(sim[rule], "same_audit_file_close", 0) for _, sim in results[(hour, minute)].values())
            all_closes = []
            for _, sim in results[(hour, minute)].values():
                all_closes.extend(sim[rule].closes)
            med = median_close_hours(all_closes)
            tot[rule] = {"filed": filed, "same_audit_file_close": sacf, "median_close_hrs": med}
        tot["B1"]["absorbed_inwin"] = sum(len(sim["absorbed_B1_inwin"]) for _, sim in results[(hour, minute)].values())
        tot["B3"]["absorbed_inwin"] = sum(len(sim["absorbed_B3_inwin"]) for _, sim in results[(hour, minute)].values())
        tot["B3k2"]["absorbed_inwin"] = sum(len(sim["absorbed_B3k2_inwin"]) for _, sim in results[(hour, minute)].values())
        tot["A"]["absorbed_inwin"] = None  # rule A has no absorption concept
        print(f"\n=== TOTALS @ {hour:02d}:{minute:02d} ===")
        print(json.dumps(tot))

    # --- Per-repo rows where B3 filed differs from A filed (at 13:00) ---
    print("\n=== repos where filed_B3 != filed_A @13:00 ===")
    for repo, (runs, sim) in results[(13, 0)].items():
        if sim["B3"].filed != sim["A"].filed:
            print(json.dumps({"repo": repo, "filed_A": sim["A"].filed, "filed_B3": sim["B3"].filed}))

    # --- Incident check: adamdaniel.ai secrets-scan.yml 8 consecutive failures ---
    print("\n=== incident check (cms-platform#279, adamdaniel.ai secrets-scan.yml) ===")
    inc_runs_13, inc_sim_13 = results[(13, 0)][INCIDENT_REPO]
    inc_runs_1530, inc_sim_1530 = results[(15, 30)][INCIDENT_REPO]
    incident_runs = [r for r in inc_runs_13 if r["id"] in INCIDENT_RUN_IDS]
    print(f"found {len(incident_runs)}/8 incident run ids in cached data")
    for r in sorted(incident_runs, key=lambda r: r["ts"]):
        print(f"  id={r['id']} conclusion={r['conclusion']} ts={r['ts']} done={r['done']}")
    # "reported under B1" = not absorbed (absorbed = in-window-but-never-findings, or never-in-window)
    absorbed_ids_13 = set(r["id"] for r in inc_sim_13["absorbed_B1_inwin"]) | set(r["id"] for r in inc_sim_13["never_in_window"])
    absorbed_ids_1530 = set(r["id"] for r in inc_sim_1530["absorbed_B1_inwin"]) | set(r["id"] for r in inc_sim_1530["never_in_window"])
    reported_b1_13 = INCIDENT_RUN_IDS - absorbed_ids_13
    reported_b1_1530 = INCIDENT_RUN_IDS - absorbed_ids_1530
    reported_b3_13 = INCIDENT_RUN_IDS & inc_sim_13["B3"].reported
    reported_b3_1530 = INCIDENT_RUN_IDS & inc_sim_1530["B3"].reported
    print(f"B1 reported @13:00: {len(reported_b1_13)}/8  (ids: {sorted(reported_b1_13)})")
    print(f"B1 reported @15:30: {len(reported_b1_1530)}/8  (ids: {sorted(reported_b1_1530)})")
    print(f"B3 reported @13:00: {len(reported_b3_13)}/8")
    print(f"B3 reported @15:30: {len(reported_b3_1530)}/8")

    print(f"\nFAIL_REASONS={fail_reasons}")
    print(f"EXIT_CODE={exit_code}")
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
