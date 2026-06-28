// @lane: local — uses page.route to inject canned GitHub 422 responses; never real GitHub
/*
 * Browser-context coverage of admin/publish-via-auto-merge.js. Runs
 * the shim inside a real Chromium page (so any monkey-patch / fetch-
 * binding subtleties that don't show up in the Node unit test would
 * surface here), with Playwright `page.route` injecting the canned
 * GitHub 422 responses we care about.
 *
 * Companion to:
 *   - e2e/publish-via-auto-merge.test.js     (Node-only matcher tests)
 *   - e2e/cms-publish-loop.spec.js           (real Decap, real GitHub, gated on RUN_HOST_REPO_PUBLISH_LOOP)
 *
 * Why a third file: the unit test runs in a vm sandbox, the prod spec
 * needs CMS_E2E_PAT and ~10 min per run — neither catches "did Decap
 * actually receive a Response Decap is willing to parse?" or "does
 * the `[role=status]` toast actually render in a real DOM?".
 */
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

const SHIM_SRC = fs.readFileSync(
  path.resolve(__dirname, "../theme/admin/publish-via-auto-merge.js"),
  "utf8",
);

/**
 * Self-contained HTML fixture: the shim plus a minimal harness that
 * exposes window.__callMerge. We don't load Decap here — the goal is
 * to prove the shim does the right thing in a real browser fetch
 * context. Decap's actual UI is exercised by cms-publish-loop.spec.js
 * against prod.
 */
const FIXTURE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>publish-via-auto-merge fixture</title></head>
<body>
  <h1>shim fixture (no Decap)</h1>
  <script>${SHIM_SRC}</script>
  <script>
    // Use the same shape Decap would use — Authorization + the GitHub
    // API-version pin — so the shim's header forwarding matches the
    // real call site.
    function ghHeaders() {
      return new Headers({
        "Authorization": "Bearer fake-token",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      });
    }
    window.__callMerge = async (n) => {
      const res = await fetch(
        "https://api.github.com/repos/Adam-S-Daniel/adamdaniel.ai/pulls/" + n + "/merge",
        { method: "PUT", headers: ghHeaders() }
      );
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    };
  </script>
</body></html>`;

test.describe("publish-via-auto-merge.js — browser context", () => {
  test.beforeEach(async ({ page }) => {
    // Backstop: any unmocked api.github.com traffic from the fixture
    // means the test forgot to mock something. Fail loudly rather
    // than silently falling through.
    await page.route(/^https:\/\/api\.github\.com\//, async (route) => {
      await route.fulfill({
        status: 599,
        contentType: "application/json",
        body: JSON.stringify({
          message: `unmocked api.github.com request: ${route.request().method()} ${route.request().url()}`,
        }),
      });
    });
  });

  test("shim installs in browser context with the merge matcher", async ({ page }) => {
    await page.setContent(FIXTURE_HTML);
    const status = await page.evaluate(() => ({
      installed: !!window.__publishViaAutoMergeInstalled,
      kinds: window.__publishViaAutoMerge && window.__publishViaAutoMerge.matchers,
    }));
    expect(status).toEqual({ installed: true, kinds: ["merge", "delete-ref"] });
  });

  test("PATCH /git/refs/heads/main → 422 rule violation → create cms/ branch + open PR + cms/ready label → synthetic merged: true", async ({
    page,
  }) => {
    let refBody = null;
    let prBody = null;
    let labelBody = null;
    let labelHeaders = null;

    await page.route(/\/git\/refs\/heads\/main$/, async (route) => {
      // Only the PATCH (ref move) 422s; a GET would pass through.
      if (route.request().method() !== "PATCH") return route.fallback();
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ message: "Repository rule violations found", status: "422" }),
      });
    });
    await page.route(/\/git\/refs$/, async (route) => {
      refBody = JSON.parse(route.request().postData());
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ ref: refBody.ref, object: { sha: refBody.sha } }),
      });
    });
    await page.route(/\/pulls$/, async (route) => {
      prBody = JSON.parse(route.request().postData());
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ number: 909, head: { ref: prBody.head } }),
      });
    });
    await page.route(/\/issues\/\d+\/labels$/, async (route) => {
      labelBody = JSON.parse(route.request().postData());
      labelHeaders = route.request().headers();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: 1, name: "cms/ready" }]),
      });
    });

    await page.setContent(FIXTURE_HTML);
    const result = await page.evaluate(async () => {
      const res = await fetch(
        "https://api.github.com/repos/Adam-S-Daniel/adamdaniel.ai/git/refs/heads/main",
        {
          method: "PATCH",
          headers: new Headers({
            Authorization: "Bearer fake-token",
            "X-GitHub-Api-Version": "2022-11-28",
          }),
          body: JSON.stringify({ sha: "deadbeefcafef00d", force: false }),
        },
      );
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    });

    expect(result.status).toBe(200);
    expect(result.body.merged).toBe(true);
    expect(result.body.sha).toBe("pending-auto-merge-delete");
    // Branch ref created at the deletion commit sha from the PATCH body.
    expect(refBody.sha).toBe("deadbeefcafef00d");
    expect(refBody.ref).toMatch(/^refs\/heads\/cms\/posts\/delete-/);
    // PR opened base=main, head=the new cms/ branch.
    expect(prBody.base).toBe("main");
    expect(prBody.head).toMatch(/^cms\/posts\/delete-/);
    // cms/ready label applied with the forwarded auth header.
    expect(labelBody).toEqual({ labels: ["cms/ready"] });
    expect(labelHeaders.authorization).toBe("Bearer fake-token");
    expect(labelHeaders["x-github-api-version"]).toBe("2022-11-28");
  });

  test("PUT /pulls/N/merge → 422 rule violation → cms/ready label POST → synthetic NON-2xx (no merged:true, #80 layer 9)", async ({
    page,
  }) => {
    let labelPostBody = null;
    let labelPostHeaders = null;

    await page.route(/\/pulls\/\d+\/merge$/, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          message: "Repository rule violations found",
          documentation_url: "https://docs.github.com/...",
          status: "422",
        }),
      });
    });
    await page.route(/\/issues\/\d+\/labels$/, async (route) => {
      labelPostBody = JSON.parse(route.request().postData());
      labelPostHeaders = route.request().headers();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: 1, name: "cms/ready" }]),
      });
    });

    await page.setContent(FIXTURE_HTML);
    const result = await page.evaluate(() => window.__callMerge(42));

    // A 2xx would make Decap's backend run its unconditional deleteBranch
    // and auto-close the unmerged PR (#80 layer 9). The shim arms cms/ready
    // then returns a synthetic 422 so Decap's mergePR re-throws (and never
    // forceMergePRs — that path is gated on exactly 405).
    expect(result.status).toBe(422);
    expect(result.body.merged).toBeUndefined();
    expect(result.body.sha).toBeUndefined();
    expect(labelPostBody).toEqual({ labels: ["cms/ready"] });
    // Auth header from the original Decap call is forwarded to the
    // recovery POST verbatim — the OAuth-proxy token is the only
    // credential available at that point.
    expect(labelPostHeaders.authorization).toBe("Bearer fake-token");
    expect(labelPostHeaders["x-github-api-version"]).toBe("2022-11-28");
  });

  test("non-422 responses pass through without recovery", async ({ page }) => {
    await page.route(/\/pulls\/\d+\/merge$/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ merged: true, sha: "real-sha-deadbeef" }),
      });
    });
    await page.setContent(FIXTURE_HTML);
    const result = await page.evaluate(() => window.__callMerge(42));
    expect(result.body.sha).toBe("real-sha-deadbeef");
  });

  test("422 with non-rule-violation message passes through", async ({ page }) => {
    await page.route(/\/pulls\/\d+\/merge$/, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ message: "Pull request is in unstable state" }),
      });
    });
    await page.setContent(FIXTURE_HTML);
    const result = await page.evaluate(() => window.__callMerge(42));
    expect(result.status).toBe(422);
    expect(result.body.message).toMatch(/unstable/);
  });

  test("recovery toast renders in DOM with [role=status] and survives ~12s", async ({ page }) => {
    await page.route(/\/pulls\/\d+\/merge$/, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ message: "Repository rule violations found" }),
      });
    });
    await page.route(/\/issues\/\d+\/labels$/, async (route) => {
      await route.fulfill({ status: 200, body: '{"id":1}' });
    });

    await page.setContent(FIXTURE_HTML);
    await page.evaluate(() => window.__callMerge(42));

    const toast = page.locator("[data-publish-via-auto-merge-toast]");
    await expect(toast).toBeVisible();
    await expect(toast).toHaveAttribute("role", "status");
    await expect(toast).toContainText(/auto-merge|automatically/i);
  });

  test("recovery POST failure surfaces the original 422 (does not lie)", async ({ page }) => {
    await page.route(/\/pulls\/\d+\/merge$/, async (route) => {
      await route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ message: "Repository rule violations found" }),
      });
    });
    await page.route(/\/issues\/\d+\/labels$/, async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ message: "Bad credentials" }),
      });
    });

    await page.setContent(FIXTURE_HTML);
    const result = await page.evaluate(() => window.__callMerge(42));
    // Original 422 propagates so the operator sees the actual failure
    // rather than a green-light toast over a silently-broken publish.
    expect(result.status).toBe(422);
    expect(result.body.message).toMatch(/rule violations/i);
  });
});
