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
 * Note: a previous version of this shim also intercepted DELETE
 * /contents and dispatched a `delete-via-pr.yml` workflow as a
 * recovery path for "Delete published entry". That intercept never
 * fired in production — Decap's delete UI uses the git data API
 * directly (POST /git/trees → POST /git/commits → PATCH
 * /git/refs/heads/main) rather than DELETE /contents, so the 422
 * the shim watches for never came back. The workflow had zero runs
 * across its lifetime; it was removed alongside the DELETE matcher
 * here.
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
    matchers: matchers.map(function (m) {
      return m.kind;
    }),
  };
})();
