// @lane: local — pure-Node sandbox unit tests for the publish-via-auto-merge shim
/*
 * Unit tests for admin/publish-via-auto-merge.js. Pure-Node, no browser:
 * we load the shim source as a string, run it inside a minimal sandbox
 * that fakes `window`, `document`, and `fetch`, then drive the wrapped
 * fetch with synthetic GitHub responses and assert the recovery path.
 *
 * This catches matcher regressions (URL/method/status filters) and
 * recovery-call shape errors without paying for the browser-driving
 * specs. The browser-driving coverage lives in:
 *
 *   - e2e/publish-via-auto-merge-mocked.spec.js     (non-prod, Decap test-repo backend with route mocks)
 *   - e2e/cms-publish-loop.spec.js                  (prod, real GitHub, RUN_HOST_REPO_PUBLISH_LOOP gate)
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test, expect } = require("./base");

const SHIM_PATH = path.resolve(__dirname, "../theme/admin/publish-via-auto-merge.js");
const SHIM_SOURCE = fs.readFileSync(SHIM_PATH, "utf8");

// The shim builds its recovery API base from `window.CMS_REPO` — the
// platform is parameterized, so a site injects `window.CMS_REPO` (mirrors
// admin/config.yml's `repo:`). The test sets a SITE-AGNOSTIC value and
// asserts the configured repo flows through into the issues/labels URL.
const TEST_REPO = "TestOwner/test-repo";
const API_BASE = `https://api.github.com/repos/${TEST_REPO}`;

/** Build a fresh sandbox + load the shim into it; returns helpers. */
function bootShim() {
  const calls = [];
  let nextResponses = [];

  // A minimal Response stand-in matching the bits the shim and tests
  // touch: status, ok, json(), text(), and clone(). The real browser
  // Response would also expose .body etc., but we don't read those.
  function makeResponse(body, init) {
    const status = (init && init.status) || 200;
    const headers = (init && init.headers) || {};
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers,
      json: () => Promise.resolve(JSON.parse(text || "null")),
      text: () => Promise.resolve(text),
      clone() {
        return makeResponse(text, init);
      },
    };
  }

  const fakeFetch = (url, init) => {
    const u = typeof url === "string" ? url : url.url;
    const method = (init && init.method) || (url && url.method) || "GET";
    calls.push({
      url: u,
      method: method.toUpperCase(),
      body: init && init.body,
      headers: init && init.headers,
      // `rawInit` is the literal second arg the shim passed through.
      // The wrap MUST forward `init` exactly as the caller supplied it
      // (including `undefined`) for non-matching requests, otherwise
      // Safari re-derives the Request body / credentials / signal from
      // defaults and `loadEntries` hangs forever on "Loading Entries…".
      rawInit: init,
    });
    if (nextResponses.length === 0) {
      throw new Error(`fake fetch out of canned responses for ${method} ${u}`);
    }
    return Promise.resolve(nextResponses.shift());
  };

  const sandbox = {
    console: {
      info: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
    },
    setTimeout: (fn) => fn,
    document: {
      createElement: () => ({
        textContent: "",
        setAttribute: () => {},
        style: { cssText: "" },
        remove: () => {},
      }),
      body: { appendChild: () => {} },
    },
    window: {
      fetch: fakeFetch,
      // Site identity is injected by the host page; the shim reads it to
      // build the recovery API base. Site-agnostic test value.
      CMS_REPO: TEST_REPO,
    },
  };
  sandbox.window.window = sandbox.window;
  // Mirror common globals onto the sandbox itself so `fetch`, `Response`,
  // etc., resolve when the shim references them via either path.
  sandbox.fetch = fakeFetch;

  // The shim does `new Response(...)`. Provide a constructor-shaped
  // shim that produces our fake-Response objects.
  function FakeResponseCtor(body, init) {
    return makeResponse(body, init);
  }
  sandbox.window.Response = FakeResponseCtor;
  sandbox.Response = FakeResponseCtor;

  // The shim references Object.assign(...) and JSON — both already on
  // sandbox via vm's default global proxy. No more setup needed.

  vm.createContext(sandbox);
  vm.runInContext(SHIM_SOURCE, sandbox);

  return {
    sandbox,
    calls,
    queueResponse: (body, init) => nextResponses.push(makeResponse(body, init)),
    fetch: (url, init) => sandbox.window.fetch(url, init),
  };
}

test.describe("publish-via-auto-merge.js (unit)", () => {
  test("installs by setting window.__publishViaAutoMergeInstalled", () => {
    const { sandbox } = bootShim();
    expect(sandbox.window.__publishViaAutoMergeInstalled).toBe(true);
    expect(sandbox.window.__publishViaAutoMerge.installed).toBe(true);
    expect(sandbox.window.__publishViaAutoMerge.matchers).toEqual(["merge", "delete-ref"]);
  });

  test("PATCH /git/refs/heads/main 200 passes through (no recovery)", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ ref: "refs/heads/main", object: { sha: "new" } }, { status: 200 });
    const res = await fetch(`${API_BASE}/git/refs/heads/main`, {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ sha: "deadbeefcafef00d", force: false }),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("delete PATCH /git/refs/heads/main 422 rule-violation → create branch + open PR + cms/ready label + synthetic merged", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    // 1) the PATCH itself → 422 rule violations
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    // 2) POST /git/refs (create the cms/ delete branch) → 201
    queueResponse({ ref: "refs/heads/cms/posts/delete-deadbeef-1" }, { status: 201 });
    // 3) POST /pulls (open the delete PR) → 201 with a number
    queueResponse({ number: 777 }, { status: 201 });
    // 4) POST /issues/777/labels → 200
    queueResponse([{ name: "cms/ready" }], { status: 200 });

    const res = await fetch(`${API_BASE}/git/refs/heads/main`, {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ sha: "deadbeefcafef00d", force: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.sha).toBe("pending-auto-merge-delete");

    expect(calls).toHaveLength(4);
    // create branch ref at the deletion commit sha read from the PATCH body
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe(`${API_BASE}/git/refs`);
    const refBody = JSON.parse(calls[1].body);
    expect(refBody.sha).toBe("deadbeefcafef00d");
    expect(refBody.ref).toMatch(/^refs\/heads\/cms\/posts\/delete-deadbeef-/);
    // open the PR, base=main
    expect(calls[2].method).toBe("POST");
    expect(calls[2].url).toBe(`${API_BASE}/pulls`);
    expect(JSON.parse(calls[2].body).base).toBe("main");
    // label the delete PR cms/ready
    expect(calls[3].method).toBe("POST");
    expect(calls[3].url).toBe(`${API_BASE}/issues/777/labels`);
    expect(JSON.parse(calls[3].body)).toEqual({ labels: ["cms/ready"] });
    expect(calls[3].headers.Authorization).toBe("Bearer t");
  });

  test("delete PATCH 422 with non-ruleset message does NOT recover", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Update is not a fast forward" }, { status: 422 });
    const res = await fetch(`${API_BASE}/git/refs/heads/main`, {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ sha: "abc", force: false }),
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(1);
  });

  test("delete PATCH 422 but branch-ref create fails → original 422 propagates", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    queueResponse({ message: "Bad credentials" }, { status: 401 }); // POST /git/refs fails
    const res = await fetch(`${API_BASE}/git/refs/heads/main`, {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ sha: "deadbeefcafef00d", force: false }),
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(2); // PATCH + failed ref create, then bail
  });

  // OVER-MATCH GUARDS (#1815 close-out audit): the delete-ref matcher must
  // recover ONLY the published-delete's ref move (PATCH /git/refs/heads/<single-
  // segment>), never an editorial DRAFT branch teardown or a non-PATCH verb.
  test("delete-ref does NOT recover a MULTI-segment editorial draft ref (PATCH /git/refs/heads/cms/posts/<x> 422)", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    const res = await fetch(`${API_BASE}/git/refs/heads/cms/posts/some-draft-slug`, {
      method: "PATCH",
      headers: { Authorization: "Bearer t" },
      body: JSON.stringify({ sha: "deadbeefcafef00d", force: false }),
    });
    expect(res.status).toBe(422); // original 422, untouched
    expect(calls).toHaveLength(1); // only the PATCH; NO ref-create/PR/label recovery
  });

  test("delete-ref does NOT match a non-PATCH verb on /git/refs/heads/main (e.g. DELETE)", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    const res = await fetch(`${API_BASE}/git/refs/heads/main`, {
      method: "DELETE",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(422); // original, untouched
    expect(calls).toHaveLength(1); // only the DELETE; NO recovery
  });

  test("re-invocation is a no-op (idempotent install)", () => {
    const ctx = bootShim();
    const fetchAfterFirst = ctx.sandbox.window.fetch;
    // Re-run the shim source against the same sandbox.
    vm.runInContext(SHIM_SOURCE, ctx.sandbox);
    expect(ctx.sandbox.window.fetch).toBe(fetchAfterFirst);
  });

  test("non-targeted requests pass through untouched", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ ok: 1 }, { status: 200 });
    const res = await fetch(`${API_BASE}/contents/_posts/x.md`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
  });

  test("non-targeted fetch(request) with NO init forwards init as undefined (Safari loadEntries fix)", async () => {
    // Regression test for the Safari-stuck-on-"Loading Entries…" bug.
    // Decap CMS's GitHub backend calls fetch with a Request object and
    // no second arg, attaching its AbortSignal to the Request. The
    // wrap used to normalise `init = init || {}` at the entry point,
    // which turned every such call into `origFetch(request, {})`.
    // Safari treats an empty `init` object as "re-derive Request
    // defaults" — it drops the AbortSignal Decap attached, the tree
    // fetch never resolves, and isFetching stays true forever. The
    // wrap MUST pass `undefined` straight through when the caller
    // didn't supply init.
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ tree: [] }, { status: 200 });
    const request = {
      url: `${API_BASE}/git/trees/main?recursive=1`,
      method: "GET",
    };
    const res = await fetch(request);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].rawInit).toBe(undefined);
  });

  test("PR merge that returns 200 passes through (no recovery)", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ merged: true, sha: "abc" }, { status: 200 });
    const res = await fetch(`${API_BASE}/pulls/42/merge`, {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  test("PR merge 422 with rule-violations triggers cms/ready label add + synthetic merged response", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    queueResponse({ id: 1 }, { status: 200 }); // labels response
    const res = await fetch(`${API_BASE}/pulls/42/merge`, {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merged).toBe(true);
    expect(body.sha).toBe("pending-auto-merge");
    expect(calls).toHaveLength(2);
    expect(calls[0].method).toBe("PUT");
    expect(calls[1].method).toBe("POST");
    // The recovery POST targets the CONFIGURED repo's issues/labels endpoint.
    expect(calls[1].url).toBe(`${API_BASE}/issues/42/labels`);
    expect(JSON.parse(calls[1].body)).toEqual({ labels: ["cms/ready"] });
    expect(calls[1].headers.Authorization).toBe("Bearer t");
  });

  test("PR merge 422 with non-ruleset message does NOT recover", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Pull request is in unstable state" }, { status: 422 });
    const res = await fetch(`${API_BASE}/pulls/42/merge`, {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(1);
  });

  test("PR merge 422 + label-add fails → original error propagates", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    queueResponse({ message: "Bad credentials" }, { status: 401 });
    const res = await fetch(`${API_BASE}/pulls/42/merge`, {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(2);
  });

  test("URL with query string after /merge does NOT match (defends against PUT to /pulls/N/merge?foo=bar)", async () => {
    // Practical reality: GitHub's merge endpoint never takes a query
    // string, but if Decap ever appended one we want to noisy-fail
    // rather than silently pass through. Today the regex anchors `/merge$`
    // so query strings would slip through. This test pins that
    // behaviour so a future refactor knows what was intentional.
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    const res = await fetch(`${API_BASE}/pulls/42/merge?foo=bar`, {
      method: "PUT",
      headers: { Authorization: "Bearer t" },
    });
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(1); // no recovery
  });

  test("Authorization header is forwarded as-is to the recovery call (Headers instance variant)", async () => {
    const { fetch, queueResponse, calls } = bootShim();
    queueResponse({ message: "Repository rule violations found" }, { status: 422 });
    queueResponse({ id: 1 }, { status: 200 });
    // Pass a Headers-like object exposing .get(...).
    const headers = {
      _store: {
        authorization: "token gho_xyz",
        "x-github-api-version": "2022-11-28",
      },
      get(k) {
        return this._store[k.toLowerCase()] || null;
      },
    };
    await fetch(`${API_BASE}/pulls/7/merge`, {
      method: "PUT",
      headers,
    });
    expect(calls[1].headers.Authorization).toBe("token gho_xyz");
    expect(calls[1].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });
});
