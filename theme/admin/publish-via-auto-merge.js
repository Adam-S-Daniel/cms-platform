/*
 * publish-via-auto-merge.js — admin/ shim that recovers the Decap
 * "Publish Now" button when it hits GitHub's branch-protection ruleset:
 *
 *   "Publish Now" on a Ready cms/ PR  → PUT /pulls/{N}/merge
 *     Decap calls the synchronous merge API. The main-branch ruleset
 *     requires every PR to pass 6 status checks (~10 min runtime),
 *     so the call returns 422 "Repository rule violations found".
 *     We recover by adding the `cms/ready` label, which makes
 *     cms-editorial-workflow.yml's `auto-merge-when-ready` job enable
 *     auto-merge — the PR then merges itself when the checks land.
 *
 * The shim only kicks in on a 422 with a "rule violations" message —
 * any other failure passes through untouched. On a successful 2xx
 * response the shim is a no-op.
 *
 * The synthetic 2xx response we hand back to Decap is a white lie:
 * the merge hasn't actually landed, it's queued. Decap's UI proceeds
 * as if it had, but a toast warns the operator that the change goes
 * live in 5–15 minutes when the auto-merge wakes up.
 *
 * Loaded via a non-deferred <script> tag in admin/index.html *before*
 * decap-cms.js, so the wrap is in place before Decap captures any
 * reference to window.fetch.
 *
 * "Delete published entry" on a published post → PATCH
 *     /git/refs/heads/<default-branch>. Decap's delete UI does NOT use
 *     DELETE /contents; it uses the git data API directly
 *     (GET /branches/<b> → POST /git/trees with sha:null → POST
 *     /git/commits → PATCH /git/refs/heads/<b>). Steps 1-3 succeed
 *     (dangling tree/commit objects are not ruleset-gated); the final
 *     PATCH that moves the branch ref returns 422 "Repository rule
 *     violations found" because direct writes to the protected branch
 *     are blocked. main is never updated, no PR is opened, no deploy
 *     fires. We recover by reading the deletion commit sha straight
 *     out of the PATCH request body, creating a `cms/` branch ref at
 *     that commit, opening a PR (base=<default-branch>), and adding
 *     the `cms/ready` label so the SAME auto-merge-when-ready job
 *     lands the delete PR (whose diff removes the file) once the
 *     required checks pass. Decap gets a synthetic merged:true.
 *
 * Note: a previous version of this shim instead intercepted DELETE
 * /contents and dispatched a `delete-via-pr.yml` workflow. That
 * intercept never fired in production — for the reason above (git
 * data API, not DELETE /contents) — and the workflow had zero runs;
 * it was removed and replaced by the PATCH /git/refs delete-ref
 * recovery matcher below.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || typeof window.fetch !== "function") return;
  if (window.__publishViaAutoMergeInstalled) return;
  window.__publishViaAutoMergeInstalled = true;

  // Same value as admin/config.yml's `repo:` field. Hard-coded so the
  // dependency is obvious; if we ever swap repos this string and
  // config.yml have to move together.
  var REPO = window.CMS_REPO;
  var API = "https://api.github.com/repos/" + REPO;

  var origFetch = window.fetch.bind(window);

  // First match wins. Each matcher is two functions: `test` returns
  // either null (no match) or a context object describing the
  // intercept; `recover` runs only when the original request actually
  // failed with the rule-violation 422 we care about.
  var matchers = [
    {
      kind: "merge",
      test: function (url, method) {
        if (method !== "PUT") return null;
        var m = url.match(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/);
        return m ? { prNumber: m[1] } : null;
      },
      recover: async function (ctx, init, originalRes) {
        var labelRes = await origFetch(API + "/issues/" + ctx.prNumber + "/labels", {
          method: "POST",
          headers: extractAuth(init.headers),
          body: JSON.stringify({ labels: ["cms/ready"] }),
        });
        // 200/201 = label added; some GitHub responses use 422 when the
        // label is already on the issue, which is fine — it means the
        // editorial workflow already knows about this PR.
        if (!labelRes.ok && labelRes.status !== 422) {
          return originalRes;
        }
        toast(
          "Publishing in the background — auto-merge will land this when " +
            "the required CI checks finish (~5–15 min). You can close this " +
            "tab; the entry goes live automatically.",
        );
        // Synthetic merge response. Decap reads `merged: true` and
        // shows its own success toast; the editor's "published" UI
        // state is technically a few minutes ahead of reality, which
        // the toast above explains.
        return new Response(
          JSON.stringify({
            sha: "pending-auto-merge",
            merged: true,
            message: "Pull Request enqueued for auto-merge via cms/ready label",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
    {
      // "Delete published entry": Decap's github backend commits the
      // delete straight to the protected branch via the git data API
      // and the final PATCH /git/refs/heads/<branch> (the ref move) is
      // the call the ruleset 422s. Steps before it (POST /git/trees,
      // POST /git/commits) succeed, so by the time we see this PATCH the
      // deletion commit already exists — its sha is right here in the
      // PATCH request body. We turn that orphan commit into a labelled
      // delete PR instead of a blocked direct push.
      kind: "delete-ref",
      test: function (url, method) {
        if (method !== "PATCH") return null;
        var m = url.match(
          /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/([^/?#]+)$/,
        );
        return m ? { branch: decodeURIComponent(m[1]) } : null;
      },
      recover: async function (ctx, init, originalRes) {
        // The deletion commit sha is the `sha` Decap is trying to fast-
        // forward the branch to — it's in the PATCH body. Reuse it; do
        // NOT build a new tree/commit (Decap already did, steps 2-3).
        var commitSha = null;
        try {
          var reqBody = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
          commitSha = reqBody && reqBody.sha;
        } catch {
          /* unparseable body — fall through to the guard below */
        }
        if (!commitSha) return originalRes;

        var auth = extractAuth(init.headers);
        // Unique `cms/`-prefixed branch so the editorial-workflow
        // cms/draft labeller, sweep-stale-cms-prs, the editorial-label
        // audit, and the prod-mutate spec's "label the delete cms/... PR"
        // detect-loop (head.ref.startsWith('cms/') + file removed) all
        // recognise it. Short-sha + timestamp keeps retries collision-free.
        var deleteBranch =
          "cms/posts/delete-" + String(commitSha).slice(0, 8) + "-" + Date.now();

        var refRes = await origFetch(API + "/git/refs", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ ref: "refs/heads/" + deleteBranch, sha: commitSha }),
        });
        // 201 = created; 422 = ref already exists (a retry) — both are
        // recoverable. Anything else: hand back the original 422.
        if (!refRes.ok && refRes.status !== 422) return originalRes;

        var prRes = await origFetch(API + "/pulls", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({
            title: "delete: published entry via Decap (auto-merge)",
            head: deleteBranch,
            base: ctx.branch,
            body:
              "Recovered delete-published commit " +
              commitSha +
              " — the direct " +
              "PATCH /git/refs/heads/" +
              ctx.branch +
              " was blocked by branch protection. " +
              "Auto-merges via the `cms/ready` label.",
          }),
        });
        if (!prRes.ok) return originalRes;
        var pr = await prRes.json();
        if (!pr || !pr.number) return originalRes;

        var labelRes = await origFetch(API + "/issues/" + pr.number + "/labels", {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ labels: ["cms/ready"] }),
        });
        if (!labelRes.ok && labelRes.status !== 422) return originalRes;

        toast(
          "Removing in the background — auto-merge will land this delete when " +
            "the required CI checks finish (~5–15 min). You can close this " +
            "tab; the entry comes down automatically.",
        );
        // Synthetic success so Decap's UI proceeds as if the ref moved.
        // The labelled delete PR lands the removal for real once checks pass.
        return new Response(
          JSON.stringify({
            sha: "pending-auto-merge-delete",
            ref: "refs/heads/" + ctx.branch,
            object: { sha: commitSha },
            merged: true,
            message: "Delete enqueued for auto-merge via cms/ready label (PR #" + pr.number + ")",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    },
  ];

  function extractAuth(headers) {
    // Headers may arrive as a Headers instance, a plain object, or an
    // array of pairs. We only need Authorization (the operator's
    // GitHub token via the OAuth proxy) and the API-version pin.
    var out = { "Content-Type": "application/json" };
    if (!headers) return out;
    if (typeof headers.get === "function") {
      var auth = headers.get("Authorization") || headers.get("authorization");
      if (auth) out.Authorization = auth;
      var apiv = headers.get("X-GitHub-Api-Version") || headers.get("x-github-api-version");
      if (apiv) out["X-GitHub-Api-Version"] = apiv;
      return out;
    }
    var lower = {};
    if (Array.isArray(headers)) {
      headers.forEach(function (p) {
        lower[String(p[0]).toLowerCase()] = p[1];
      });
    } else {
      Object.keys(headers).forEach(function (k) {
        lower[k.toLowerCase()] = headers[k];
      });
    }
    if (lower.authorization) out.Authorization = lower.authorization;
    if (lower["x-github-api-version"]) out["X-GitHub-Api-Version"] = lower["x-github-api-version"];
    return out;
  }

  function toast(msg) {
    try {
      var t = document.createElement("div");
      t.textContent = msg;
      t.setAttribute("role", "status");
      t.setAttribute("data-publish-via-auto-merge-toast", "");
      t.style.cssText =
        "position:fixed;bottom:24px;left:50%;transform:translateX(-50%);" +
        "background:#1f2937;color:#fff;padding:14px 20px;border-radius:8px;" +
        "font:14px/1.4 system-ui,sans-serif;max-width:560px;z-index:2147483647;" +
        "box-shadow:0 8px 24px rgba(0,0,0,.3);";
      document.body.appendChild(t);
      setTimeout(function () {
        try {
          t.remove();
        } catch {
          /* ignore */
        }
      }, 14000);
    } catch {
      /* DOM not ready — log only */
    }
    // Always log; useful for the playwright spec to assert via console.
    console.info("[publish-via-auto-merge]", msg);
  }

  window.fetch = function (input, init) {
    // Read inputs without mutating `init`. Most Decap calls go through
    // here as `fetch(request)` (no init at all) — the previous
    // `init = init || {}` reassignment turned every such call into
    // `origFetch(request, {})`, and Safari is stricter than Chrome
    // about an empty `init` object: it re-derives the Request body /
    // credentials / signal from defaults instead of keeping the
    // ones already on the Request, which wedged `loadEntries` on
    // Safari (the spinner stays on "Loading Entries…" forever
    // because the AbortSignal Decap attached to the tree fetch is
    // dropped, the fetch never resolves, and the entries reducer
    // never transitions out of isFetching). Pass the caller's
    // ORIGINAL `init` (possibly undefined) straight through so the
    // wrap is truly transparent for non-matching requests.
    var url = typeof input === "string" ? input : (input && input.url) || "";
    var method = ((init && init.method) || (input && input.method) || "GET").toUpperCase();

    var match = null;
    var matcher = null;
    for (var i = 0; i < matchers.length && !match; i++) {
      var ctx = matchers[i].test(url, method);
      if (ctx) {
        match = ctx;
        matcher = matchers[i];
      }
    }

    if (!matcher) return origFetch.call(this, input, init);

    return origFetch.call(this, input, init).then(function (res) {
      // The `merge` matcher recovers on BOTH the ruleset rejection (422
      // "rule violations") AND a not-yet-mergeable response (405/409):
      // Decap's "Publish Now" PUT /merge returns 405 when the required
      // checks have not recomputed yet — e.g. an unpublish / re-edit issued
      // right after the base moved — which previously dead-ended with no
      // arm, no deploy (#85 / #80 layer 8). Arming `cms/ready` is the
      // correct, idempotent action there too. The `delete-ref` matcher
      // stays strictly on the 422 ruleset path.
      var notYetMergeable =
        matcher.kind === "merge" && (res.status === 405 || res.status === 409);
      if (notYetMergeable) {
        console.info(
          "[publish-via-auto-merge] merge PUT " +
            res.status +
            " (not mergeable yet) \u2014 arming cms/ready",
        );
        return matcher.recover(match, init || {}, res).catch(function (err) {
          console.error("[publish-via-auto-merge] recover threw:", err);
          return res;
        });
      }
      if (res.status !== 422) return res;
      var clone;
      try {
        clone = res.clone();
      } catch {
        return res;
      }
      return clone.json().then(
        function (body) {
          var msg = body && body.message ? String(body.message) : "";
          if (!/rule violations/i.test(msg)) return res;
          // Recovery path reads `init.headers` to forward Authorization;
          // normalise here (not at the top of the wrap) so the no-match
          // pass-through above keeps the caller's exact args.
          return matcher.recover(match, init || {}, res).catch(function (err) {
            console.error("[publish-via-auto-merge] recover threw:", err);
            return res;
          });
        },
        function () {
          return res;
        },
      );
    });
  };

  // Tiny surface for tests / debugging — lets a spec verify the wrap
  // is installed and inspect the kind of the most recent intercept.
  window.__publishViaAutoMerge = {
    installed: true,
    origFetch: origFetch,
    // ['merge','delete-ref'] — exposed so specs can assert both the
    // create-leg and delete-leg recovery matchers are installed.
    matchers: matchers.map(function (m) {
      return m.kind;
    }),
  };
})();
