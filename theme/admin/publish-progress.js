/*
 * admin/publish-progress.js — the facts behind "is this on the website?".
 *
 * ── The defect this closes (docs/PUBLISHING-UX.md §2.4) ────────────────
 * After "Publish now" an editor's complete feedback is:
 *
 *   1. a toast from publish-via-auto-merge.js, removed after 14 s;
 *   2. Decap's own red "failed to publish" error, which is WRONG — the
 *      shim hands Decap a deliberate 422 so it never deletes the head ref;
 *   3. then nothing at all, for five to fifteen minutes;
 *   4. and only THEN deploy-status-pill.js has something to show, because
 *      it polls GitHub Deployments and deploy-production registers one
 *      only AFTER the merge.
 *
 * So the longest phase of the most consequential action in the product —
 * the required checks — has no signal whatsoever, and the one signal it
 * does have says the opposite of the truth.
 *
 * This module is the missing half: it polls the ENTRY'S OWN PULL REQUEST,
 * which exists from the moment of Save, and reports the whole window. It
 * gathers facts only; the words are entry-status-model.js's job and the
 * rendering is publish-step-hint.js's, so a single derivation feeds every
 * surface and they cannot drift (§2.9).
 *
 * ── Public DOM + public REST only ──────────────────────────────────────
 * The house rule for everything in theme/admin/: no window.CMS internals,
 * no Decap Redux store. The entry is identified from `location.hash`, which
 * is Decap's own public route, and the PR from the `cms/<collection>/<slug>`
 * branch convention that publish-via-auto-merge.js creates and
 * posts-list-enhance.js already queries. Auth is the editor's own Decap
 * token out of localStorage — the same one deploy-status-pill.js uses. No
 * CMS_E2E_PAT, no second credential.
 *
 * ── The facts, and where each comes from ───────────────────────────────
 *   hasOpenPr         an open PR whose head ref is cms/<collection>/<slug>
 *   armed             cms/ready or decap-cms/pending_publish on that PR, or
 *                     native auto_merge already enabled
 *   merged            the PR merged; the deploy is the only step left
 *   checksFailed      any check run on the BRANCH TIP (git ref, not the
 *                     PR list's lagging head.sha — adamdaniel.ai#3857)
 *                     concluded failure /
 *                     timed_out / cancelled  (cancelled counts: a cancelled
 *                     REQUIRED context blocks the merge and nothing
 *                     overrides it — docs/CI-INVARIANTS.md, #1815/#285/#289)
 *   awaitingReviewGate a workflow run on the head sha is `waiting`, which is
 *                     exactly and only GitHub's state for a run parked on a
 *                     manual environment approval — the regression-review
 *                     gate of §2.7, the failure mode that presents to an
 *                     editor as "pressed Publish, nothing happened, forever"
 *   previewOnly       the PR's base is NOT the repo's default branch — i.e.
 *                     this admin is a PR-preview deploy, whose config.yml
 *                     scripts/patch-preview-config.sh rewrote to the preview
 *                     branch. Both signals come free out of the /pulls LIST
 *                     response, so this costs no extra request: the
 *                     `cms/preview-only` label cms-editorial-workflow.yml
 *                     applies, OR base.ref !== base.repo.default_branch. The
 *                     label alone would be racy (it is applied a few seconds
 *                     after `opened`); the branch compare alone would miss a
 *                     site whose default branch is not what the ruleset
 *                     protects. Neither hardcodes `main`.
 *   settledSince      ms epoch at which this PR FIRST looked settled-but-
 *                     unmerged, or null. See "The stall" below.
 *   checksUrl         the workflow run behind a failed check, else behind the
 *                     running ones, or null. Free out of the check-runs read
 *                     this tick already makes. See checksUrlFor().
 *
 * ── The stall: an armed publish with nothing left to wait for (#371) ────
 * `armed` says the PR is queued to merge itself. Nothing said whether that
 * queue ever moves, so every failure of the merge machinery presented as
 * "Going live…" FOREVER — honest about what it knew and, after ten minutes,
 * indistinguishable from a lie. Measured instance: jodidaniel.com#233, armed
 * at 22:05, every check green by 22:06, still open and unmerged twenty
 * minutes later when a human merged it by hand.
 *
 * The signal is POSITIVE and needs no timer and no threshold guess: a PR that
 * is armed, has at least one check run, has NO incomplete check run, nothing
 * red, no conflict and no review-gate park has NOTHING LEFT TO WAIT FOR — so
 * if it is still open, the merge is not coming on its own. That is a fact
 * about the PR, not an elapsed-time heuristic.
 *
 * One timestamp is still recorded rather than reporting the stall instantly,
 * because there is a legitimate seconds-wide window in which it holds: native
 * auto-merge fires a moment AFTER the last check completes. `settledSince`
 * is when the condition first held CONTINUOUSLY (reset on any change of PR or
 * head sha, and on the condition lapsing); entry-status-model.js applies the
 * grace period, so the threshold lives in the pure, unit-tested module and
 * this one stays a fact-gatherer.
 *
 * `startedAt` for the ETA is the OLDEST `started_at` among ALL the check
 * runs on the tip — deliberately not "when this tab noticed", so a
 * reload mid-flight does not restart the estimate, and not the label's own
 * timestamp, which would cost an extra timeline request per tick.
 *
 * ── Budget ─────────────────────────────────────────────────────────────
 * At most five GitHub requests per 30 s tick (open PR: pulls, branch ref,
 * check-runs, pull, workflow runs; no open PR: pulls, merged pulls,
 * deployments, deployment statuses), and only while the tab is VISIBLE and
 * the route is an entry route. That is ~600/hour against an authenticated
 * 5000/hour budget, alongside deploy-status-pill.js's own ~480.
 *
 * ── After the merge (adamdaniel.ai#3857) ──────────────────────────────
 * Once the PR merges it is no longer open, and deploy-production registers
 * its deployment a few seconds later. In that window the newest production
 * deployment is the PREVIOUS one, state `success`, so the entry read as Live
 * and the bar — which hides a plain Live — vanished mid-publish. The entry's
 * own most recent merged PR is now read on this path, and "going live" holds
 * until a production deployment covering the merge has succeeded.
 *
 * Only a merge into the default branch goes to production. A merge into a
 * feature branch reaches that branch and its preview, not the live site, so
 * for MERGE_WATCH_MS that path reports the merge as in flight to the preview
 * (`merged` + `previewOnly` with the merge's base) and never reads the
 * production deployment: "Going live… on <apex>" for it was false (#532).
 * The poller does not see the preview's own deploy, so it says "on its way
 * to" the preview, never "on" it. After the window the merge is ignored, as
 * an old default-branch merge is.
 *
 * Which branch the merge went into, in order (mergeIsPreview()):
 *   - a KNOWN base equal to the repo's default branch is production, even
 *     with the `cms/preview-only` label: GitHub retargets a PR to main when
 *     its feature branch merges and is deleted, and the label stays;
 *   - a known base that is not the default branch is a preview;
 *   - otherwise (base or default branch unknown) it is treated as a preview
 *     with no named branch, labeled or not. That understates ("not on the
 *     live site yet") rather than claiming the live site without evidence.
 *
 * A hidden tab polls nothing: an admin left open in a background tab
 * overnight must not spend the editor's rate limit on an entry nobody is
 * looking at.
 *
 * Every fetch degrades to "no facts" rather than throwing — a rate limit, a
 * revoked token or an offline laptop leaves the surfaces showing their last
 * known state, never a page error.
 *
 * ── Why every read says `cache: "no-cache"` (#386) ────────────────────
 * GitHub REST responses carry `Cache-Control: private, max-age=60`, and a
 * browser fetch() honours it: for 60 s after any GET the same URL is
 * answered from Chromium's HTTP cache without touching the network. For a
 * poller that is fatal — every refresh() inside that minute returned the
 * snapshot from BEFORE the label it was polling for landed, so the bar sat
 * on "Publish" for a full minute after the PR was armed (measured:
 * adamdaniel.ai host-loop run 33580693718, every /pulls read for 58 s
 * answered in 1 ms). `no-cache` still lets the browser revalidate with
 * If-None-Match, and a 304 does not count against the rate limit, so the
 * budget above is unchanged. e2e/admin-github-fetch-cache.test.js holds
 * the line for every shim.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;
  if (window.__publishProgressInstalled) return;
  window.__publishProgressInstalled = true;

  var REPO = window.CMS_REPO;
  var API = "https://api.github.com/repos/" + REPO;
  var POLL_MS = 30 * 1000;
  // Labels that mean "this PR is queued to merge itself". Both are real
  // arming signals on this platform: publish-via-auto-merge.js writes
  // `cms/ready`, and Decap's own Status→Ready writes
  // `decap-cms/pending_publish` — the same auto-merge-when-ready job fires
  // on either (§2.2). one-door-publish.js hides the second route on the
  // production shell, but a PR armed that way BEFORE the shim shipped is
  // still in flight and must still read as in flight.
  var ARMED_LABELS = ["cms/ready", "decap-cms/pending_publish"];
  var FAILED_CONCLUSIONS = ["failure", "timed_out", "cancelled", "action_required", "stale"];
  // Applied by cms-editorial-workflow.yml's "Apply draft label on new PR" step
  // to every CMS PR whose base is not `main`.
  var PREVIEW_ONLY_LABEL = "cms/preview-only";
  // How long after a merge a production deploy that has not picked it up
  // still reads as "on its way" rather than as the older reading (Live).
  // Deploys start within seconds of a merge and take under a minute
  // (measured: adamdaniel.ai#3857 merged 13:40:14, deploy 13:40:14–13:40:46),
  // so 30 minutes only ever expires on a deploy chain that is broken.
  var MERGE_WATCH_MS = 30 * 60 * 1000;

  // When the settled-but-unmerged condition first held, and for which
  // <pr>:<sha>. Any change of either resets it, so a re-save (Decap
  // force-pushes the same branch) starts the clock over rather than
  // inheriting a stall reading from the previous head.
  var settled = { key: null, since: null };

  function noteSettled(key, isSettled, now) {
    if (!isSettled) {
      settled = { key: null, since: null };
      return null;
    }
    if (settled.key !== key) settled = { key: key, since: now };
    return settled.since;
  }

  var listeners = [];
  var state = { ready: false, facts: null, prNumber: null, prUrl: null, entry: null };

  function getToken() {
    try {
      var raw = localStorage.getItem("decap-cms-user");
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && parsed.token ? parsed.token : null;
    } catch (e) {
      return null;
    }
  }

  function headers(token) {
    return {
      Authorization: "token " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  // Every call site treats null as "no facts this tick" and keeps the last
  // render. Never throws.
  async function getJson(url, token, label) {
    try {
      var res = await fetch(url, { headers: headers(token), cache: "no-cache" });
      if (!res.ok) {
        console.info("[publish-progress] " + label + " HTTP " + res.status + " — skipping tick.");
        return null;
      }
      return await res.json();
    } catch (err) {
      console.info(
        "[publish-progress] " + label + " unavailable: " +
          (err && err.message ? err.message : String(err)),
      );
      return null;
    }
  }

  // ── Route → entry ─────────────────────────────────────────────────────
  // Decap's own hash routes. `#/collections/<name>/entries/<slug>` is an
  // existing entry; `/new` has no branch yet and no PR, so it is not an
  // entry for this module's purposes.
  function currentEntry() {
    var hash = location.hash || "";
    var m = /#\/collections\/([^/]+)\/entries\/([^/?]+)/.exec(hash);
    if (!m) return null;
    return { collection: decodeURIComponent(m[1]), slug: decodeURIComponent(m[2]) };
  }

  // Decap's editorial-workflow branch for an entry is
  // `cms/<contentKey>` where contentKey is `<collection>/<slug>` — the
  // convention publish-via-auto-merge.js's delete-recovery also writes.
  function branchFor(entry) {
    return "cms/" + entry.collection + "/" + entry.slug;
  }

  function matchesEntry(ref, entry) {
    if (!ref) return false;
    var want = branchFor(entry);
    if (ref === want) return true;
    // Lenient tail match: Decap sanitizes some slugs on the way into a
    // branch name, so an exact compare alone would silently report "no PR"
    // (which renders as Live) for an entry that has one. Erring toward
    // matching is the safe direction here — the wrong answer in the other
    // direction tells an editor a draft is already on the website.
    return ref.indexOf("cms/" + entry.collection + "/") === 0 && ref.slice(-entry.slug.length) === entry.slug;
  }

  // A branch name as a URL path: each `/`-separated segment encoded on its
  // own, so `cms/posts/<slug>` stays three path segments rather than one
  // `%2F` blob the git refs endpoint does not resolve.
  function refPath(ref) {
    return String(ref || "")
      .split("/")
      .map(encodeURIComponent)
      .join("/");
  }

  // ── The run behind the sentence ───────────────────────────────────────
  // Where the bar links "did not pass" / "waiting for one last check".
  // A failed check wins: that is the run somebody has to open. Otherwise the
  // running checks — one workflow run's page when they all belong to one,
  // else the PR's Checks tab, which lists them all. For an Actions check,
  // `details_url` is the job inside its workflow run; `html_url` (always on
  // github.com) is the fallback for a check some other app wrote.
  // entry-status-model.js re-checks the origin before anything reaches an href.
  var GITHUB_URL = /^https:\/\/github\.com\//;
  var WORKFLOW_RUN_URL = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+)(?:\/|$)/;

  function runLink(r) {
    if (r && GITHUB_URL.test(r.details_url || "")) return r.details_url;
    if (r && GITHUB_URL.test(r.html_url || "")) return r.html_url;
    return null;
  }

  function checksUrlFor(pr, failedRuns, incomplete) {
    if (failedRuns.length) return runLink(failedRuns[0]);
    if (!incomplete.length) return null;
    if (incomplete.length === 1) return runLink(incomplete[0]);
    var runUrls = incomplete.map(function (r) {
      var m = WORKFLOW_RUN_URL.exec(r.details_url || "");
      return m ? m[1] : null;
    });
    var one = runUrls.every(function (u) {
      return u && u === runUrls[0];
    });
    if (one) return runUrls[0];
    return pr.html_url ? pr.html_url + "/checks" : null;
  }

  // ── Fact gathering ────────────────────────────────────────────────────
  async function gather(token, entry) {
    var prs = await getJson(API + "/pulls?state=open&per_page=100", token, "open pulls");
    if (prs === null) return null;

    var pr = (Array.isArray(prs) ? prs : []).filter(function (p) {
      return matchesEntry(p.head && p.head.ref, entry);
    })[0];

    if (!pr) {
      // No open PR. Either it merged and is deploying (or about to), or it is
      // live, or it was never saved as a draft. See "After the merge" in the
      // header for why the entry's own merged PR is read here.
      var merge = await recentMerge(token, entry);
      var now = Date.now();
      if (merge && merge.previewOnly && now - merge.mergedAt < MERGE_WATCH_MS) {
        // Merged into a feature branch: on its way to that branch's preview,
        // and the live site only when the branch gets there, so production's
        // deployment says nothing about it (see "After the merge").
        return {
          facts: {
            hasOpenPr: false,
            armed: false,
            merged: true,
            checksFailed: false,
            mergeConflict: false,
            awaitingReviewGate: false,
            deployState: null,
            waitingOn: null,
            startedAt: merge.mergedAt,
            previewOnly: true,
            baseRef: merge.baseRef,
            settledSince: noteSettled(null, false, now),
            checksUrl: null,
          },
          prNumber: null,
          prUrl: null,
        };
      }
      var dep = await latestProductionDeployment(token);
      var depState = dep ? dep.state : null;
      var deploying = depState === "in_progress" || depState === "queued" || depState === "pending";
      var startedAt = dep && deploying ? dep.createdAt : null;
      var inFlight = Boolean(deploying);
      if (merge && !merge.previewOnly && now - merge.mergedAt < MERGE_WATCH_MS) {
        // A deployment covers the merge if it IS the merge commit, or was
        // created after it (deploys run per push to the default branch, in
        // order, so a later one carries this commit too).
        var covers = dep && (dep.sha === merge.sha || dep.createdAt >= merge.mergedAt);
        if (!covers) {
          // Merged, and production has not started on it yet: the bar used
          // to read the PREVIOUS deploy's `success` here and go blank.
          inFlight = true;
          depState = "pending";
          startedAt = merge.mergedAt;
        } else if (deploying) {
          startedAt = merge.mergedAt;
        }
      }
      return {
        facts: {
          hasOpenPr: false,
          armed: false,
          merged: inFlight,
          checksFailed: false,
          mergeConflict: false,
          awaitingReviewGate: false,
          deployState: depState,
          waitingOn: null,
          startedAt: inFlight ? startedAt : null,
          previewOnly: false,
          baseRef: null,
          settledSince: noteSettled(null, false, now),
          checksUrl: null,
        },
        prNumber: null,
        prUrl: null,
      };
    }

    var labels = (pr.labels || []).map(function (l) {
      return typeof l === "string" ? l : l.name;
    });
    var armed =
      Boolean(pr.auto_merge) ||
      ARMED_LABELS.some(function (name) {
        return labels.indexOf(name) !== -1;
      });

    // Free out of the list response — `base.repo` is a full repository
    // object, so `default_branch` costs nothing. OR-ing the two signals errs
    // toward "this is a preview", which is the safe direction: the wrong
    // answer the other way tells an editor on a preview that their change is
    // going to the live website.
    var baseRef = (pr.base && pr.base.ref) || null;
    var defaultBranch = (pr.base && pr.base.repo && pr.base.repo.default_branch) || null;
    var previewOnly =
      labels.indexOf(PREVIEW_ONLY_LABEL) !== -1 ||
      Boolean(baseRef && defaultBranch && baseRef !== defaultBranch);

    // The commit whose checks decide the verdict is the BRANCH TIP, read off
    // the git ref — not `pr.head.sha`. GitHub updates a PR's head sha
    // asynchronously after a push while the ref moves at once, so right after
    // Save → Publish the list still names the PREVIOUS commit, whose checks may
    // have failed: adamdaniel.ai#3857 read eb9ffb8's failures for over a minute
    // after 60716fc landed and told the editor "a safety check did not pass"
    // for a publish that was under way. A failed ref read falls back to the
    // list's sha, which is exactly the behavior before this read existed.
    var tip = await getJson(API + "/git/ref/heads/" + refPath(pr.head && pr.head.ref), token, "branch ref");
    var sha = (tip && tip.object && tip.object.sha) || (pr.head && pr.head.sha);
    var checks = sha ? await getJson(API + "/commits/" + sha + "/check-runs?per_page=100", token, "check-runs") : null;
    var runs = checks && Array.isArray(checks.check_runs) ? checks.check_runs : [];

    var failedRuns = runs.filter(function (r) {
      return r.status === "completed" && FAILED_CONCLUSIONS.indexOf(r.conclusion) !== -1;
    });
    var failed = failedRuns.length > 0;

    var incomplete = runs.filter(function (r) {
      return r.status !== "completed";
    });
    // The ETA clock starts at the FIRST check to start, completed ones
    // included: that is when this commit's run of checks began, and it does
    // not jump later each time an early check finishes.
    var startedAt = null;
    runs.forEach(function (r) {
      var t = Date.parse(r.started_at || "");
      if (!isNaN(t) && (startedAt === null || t < startedAt)) startedAt = t;
    });

    // One entry per WORKFLOW, not per job: "e2e / project (chromium-laptop)"
    // and its thirteen siblings are one check to an editor. The key is the caller job
    // id before " / "; entry-status-model.js turns it into words (#3857).
    var groups = [];
    var pendingGroups = [];
    runs.forEach(function (r) {
      var key = String(r.name || "").split(" / ")[0];
      if (groups.indexOf(key) === -1) groups.push(key);
      if (r.status !== "completed" && pendingGroups.indexOf(key) === -1) pendingGroups.push(key);
    });

    // `mergeable` is NOT in the /pulls LIST response — only the single-PR
    // endpoint carries it, and GitHub computes it lazily (null until it has).
    // Reading it off the list would have left the merge-conflict branch dead
    // code that looked alive. One extra request, and only while a publish is
    // actually in flight, which is the only time a conflict can block one.
    var mergeConflict = false;
    if (armed) {
      var full = await getJson(API + "/pulls/" + pr.number, token, "pull " + pr.number);
      // Only an EXPLICIT false is a conflict. `null` means "not computed yet",
      // and reporting that as a conflict would tell an editor their work is
      // broken every time GitHub is a second behind.
      if (full && full.mergeable === false) mergeConflict = true;
    }

    // The park (§2.7). GitHub sets a workflow run's status to `waiting`
    // exactly and only while it is pending a manual environment approval,
    // so this is a positive signal rather than an inference from silence.
    var awaitingReviewGate = false;
    if (armed && sha && incomplete.length) {
      var wf = await getJson(API + "/actions/runs?head_sha=" + sha + "&per_page=20", token, "workflow runs");
      var wfRuns = wf && Array.isArray(wf.workflow_runs) ? wf.workflow_runs : [];
      awaitingReviewGate = wfRuns.some(function (r) {
        return r.status === "waiting";
      });
    }

    // See "The stall" in the header. `runs.length` guards the window between
    // a push and GitHub creating the check runs for it: an empty list is "not
    // known yet", never "nothing left to wait for".
    var settledSince = noteSettled(
      pr.number + ":" + (sha || ""),
      armed &&
        runs.length > 0 &&
        incomplete.length === 0 &&
        !failed &&
        !mergeConflict &&
        !awaitingReviewGate,
      Date.now(),
    );

    return {
      facts: {
        hasOpenPr: true,
        armed: armed,
        merged: false,
        checksFailed: failed,
        mergeConflict: mergeConflict,
        awaitingReviewGate: awaitingReviewGate,
        deployState: null,
        waitingOn: null,
        checks: { total: groups.length, pending: pendingGroups },
        startedAt: startedAt,
        previewOnly: previewOnly,
        baseRef: baseRef,
        settledSince: settledSince,
        checksUrl: checksUrlFor(pr, failedRuns, incomplete),
      },
      prNumber: pr.number,
      prUrl: pr.html_url,
    };
  }

  // The entry's most recent MERGED PR, or null. Head-filtered, so one small
  // request; newest first, so a slug reused after a delete finds its latest.
  async function recentMerge(token, entry) {
    var owner = String(REPO || "").split("/")[0];
    var prs = await getJson(
      API + "/pulls?state=closed&head=" + encodeURIComponent(owner + ":" + branchFor(entry)) + "&per_page=5",
      token,
      "closed pulls",
    );
    if (!Array.isArray(prs)) return null;
    for (var i = 0; i < prs.length; i++) {
      var t = Date.parse(prs[i].merged_at || "");
      if (isNaN(t)) continue;
      var pr = prs[i];
      var baseRef = (pr.base && pr.base.ref) || null;
      var defaultBranch = (pr.base && pr.base.repo && pr.base.repo.default_branch) || null;
      return {
        mergedAt: t,
        sha: pr.merge_commit_sha || null,
        baseRef: baseRef,
        previewOnly: mergeIsPreview(baseRef, defaultBranch),
      };
    }
    return null;
  }

  // Whether a MERGED PR went into a preview branch; see "After the merge".
  // Unlike an open PR's `previewOnly`, the label never overrides a known
  // default-branch base (a retargeted PR keeps it), and when the base is
  // unknown the answer is "preview" whatever the label says, so the label
  // changes no outcome here and is not read.
  function mergeIsPreview(baseRef, defaultBranch) {
    if (baseRef && defaultBranch) return baseRef !== defaultBranch;
    return true;
  }

  // The newest production deployment and its latest state, or null.
  async function latestProductionDeployment(token) {
    var deps = await getJson(API + "/deployments?environment=production&per_page=1", token, "deployments");
    if (!Array.isArray(deps) || !deps.length) return null;
    var st = await getJson(API + "/deployments/" + deps[0].id + "/statuses?per_page=1", token, "deployment statuses");
    if (!Array.isArray(st) || !st.length) return null;
    return { sha: deps[0].sha || null, createdAt: Date.parse(deps[0].created_at || ""), state: st[0].state };
  }

  // ── Loop ──────────────────────────────────────────────────────────────
  function publish() {
    for (var i = 0; i < listeners.length; i++) {
      try {
        listeners[i](state);
      } catch (e) {
        /* one bad subscriber must never stop the others */
      }
    }
  }

  var inFlight = false;
  async function tick() {
    if (inFlight) return;
    if (document.hidden) return; // see "Budget" in the header
    var entry = currentEntry();
    if (!entry) {
      if (state.entry !== null) {
        state = { ready: true, facts: null, prNumber: null, prUrl: null, entry: null };
        publish();
      }
      return;
    }
    var token = getToken();
    if (!token) return;
    inFlight = true;
    try {
      var result = await gather(token, entry);
      if (result === null) return; // keep the last known state
      state = {
        ready: true,
        facts: result.facts,
        prNumber: result.prNumber,
        prUrl: result.prUrl,
        entry: entry,
      };
      publish();
    } finally {
      inFlight = false;
    }
  }

  window.CMSPublishProgress = {
    get: function () {
      return state;
    },
    subscribe: function (fn) {
      if (typeof fn === "function") listeners.push(fn);
      return function () {
        var i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    // Called by publish-button.js the moment it arms a PR, so the editor
    // sees "Going live…" immediately rather than up to 30 s later.
    refresh: tick,
    currentEntry: currentEntry,
    branchFor: branchFor,
    matchesEntry: matchesEntry,
    getToken: getToken,
  };

  function start() {
    tick();
    setInterval(tick, POLL_MS);
    window.addEventListener("hashchange", tick);
    // A tab brought back to the front re-polls at once rather than waiting
    // out the remainder of a tick it skipped while hidden.
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) tick();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();
