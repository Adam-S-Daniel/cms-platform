// @lane: local — mocks every GitHub API request via page.route; never approves or rejects anything
const { test, expect } = require("./base");

// /admin/reviews/ lists every visual-regression run parked at its
// approve-regression gate. Pushing a branch past a head whose run is still
// waiting leaves BOTH runs waiting, and the dashboard used to render one card
// per run: the same PR twice, each with an Approve button, one of them for a
// commit the PR no longer points at (jodidaniel.com#382, 2026-10-06 — cards for
// 6a0d723 and the older f0064cb). Approving the stale card approves a deploy
// of code that is no longer the PR.
//
// The dashboard now offers a review only for the run whose head sha is the
// PR's CURRENT head (GET /pulls/{n} -> head.sha); an older waiting run collapses
// into a quiet note with no Approve / Request Changes controls. Every GitHub
// call is mocked, and the spec fails if the page sends anything but a GET.

const FAKE_TOKEN = "ghp_fake_token_for_superseded_test";
const PR_NUMBER = 382;
const CURRENT_SHA = "6a0d7230000000000000000000000000000000aa";
const STALE_SHA = "f0064cb0000000000000000000000000000000bb";
const NEWER_SHA = "9e1c4d50000000000000000000000000000000cc";
const CURRENT_RUN = 37464002670;
const STALE_RUN = 37463094549;
const VR_PATH = ".github/workflows/visual-regression.yml";

function vrRun(id, sha) {
  return { id, name: `PR #${PR_NUMBER}`, path: VR_PATH, head_sha: sha, pull_requests: [{ number: PR_NUMBER }] };
}

// Mock the dashboard's GitHub traffic. `runs` is the waiting-runs list (newest
// first, as the API returns it); `prHead` is the PR's current head sha.
async function installMocks(page, { runs, prHead }) {
  const writes = [];
  await page.addInitScript((token) => {
    localStorage.setItem("gh_reviews_token", token);
  }, FAKE_TOKEN);
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (req.method() !== "GET") {
      writes.push(`${req.method()} ${path}`);
      return route.fulfill({ status: 500, body: "{}" });
    }
    const json = (body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/user") return json({ login: "superseded-spec-user" });
    if (path.endsWith("/actions/runs")) return json({ workflow_runs: runs });
    if (path.endsWith("/pending_deployments")) return json([{ environment: { id: 11 } }]);
    if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
      return json({ title: "Raise tagline and footer contrast", head: { ref: "fix/contrast", sha: prHead } });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  // Stats and video live on the preview host; keep them off the network.
  await page.route(/^https:\/\/preview-pr\d+\./, (route) => route.fulfill({ status: 404, body: "" }));
  return writes;
}

test.describe("/admin/reviews/ superseded runs", { tag: ["@admin-read"] }, () => {
  test("one PR with a current and a superseded waiting run renders ONE reviewable card", async ({ page }) => {
    const writes = await installMocks(page, {
      runs: [vrRun(CURRENT_RUN, CURRENT_SHA), vrRun(STALE_RUN, STALE_SHA)],
      prHead: CURRENT_SHA,
    });

    await page.goto("/admin/reviews/");
    await expect(page.locator("#dashboard")).toBeVisible();

    const cards = page.locator(`.review-card[data-pr-num="${PR_NUMBER}"]`);
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute("data-run-id", String(CURRENT_RUN));
    await expect(cards.locator(".review-meta")).toContainText(CURRENT_SHA.slice(0, 7));
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(1);

    // The stale run is named, quietly, with the commit that replaced it — and
    // offers nothing to click but a link to the run.
    const note = page.locator(".superseded-note");
    await expect(note).toHaveCount(1);
    await expect(note).toContainText(STALE_SHA.slice(0, 7));
    await expect(note).toContainText(CURRENT_SHA.slice(0, 7));
    await expect(note.locator("button")).toHaveCount(0);
    await expect(note.locator("a")).toHaveAttribute("href", new RegExp(`/actions/runs/${STALE_RUN}$`));

    expect(writes).toEqual([]);
  });

  test("a PR whose head moved past every waiting run offers no Approve at all", async ({ page }) => {
    const writes = await installMocks(page, {
      runs: [vrRun(CURRENT_RUN, CURRENT_SHA), vrRun(STALE_RUN, STALE_SHA)],
      prHead: NEWER_SHA,
    });

    await page.goto("/admin/reviews/");
    await expect(page.locator("#dashboard")).toBeVisible();
    await expect(page.locator(".superseded-note")).toHaveCount(2);
    await expect(page.locator(".review-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect(writes).toEqual([]);
  });

  test("header buttons keep their labels on one line", async ({ page }) => {
    await installMocks(page, { runs: [], prHead: CURRENT_SHA });
    await page.goto("/admin/reviews/");
    await expect(page.locator("#dashboard")).toBeVisible();

    // On a 393px phone "Back to CMS" used to break onto three lines and
    // "QA health" onto two (2026-10-06 screenshot). Each label must be one line.
    for (const btn of await page.locator("header .header-actions .btn").all()) {
      const { height, lineHeight } = await btn.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
            - parseFloat(cs.borderTopWidth) - parseFloat(cs.borderBottomWidth),
          lineHeight: parseFloat(cs.fontSize) * 1.6,
        };
      });
      expect(height, await btn.textContent()).toBeLessThan(lineHeight);
    }
  });

  test("print drops the decorative background glow", async ({ page }) => {
    await installMocks(page, { runs: [], prHead: CURRENT_SHA });
    await page.goto("/admin/reviews/");
    await expect(page.locator("#dashboard")).toBeVisible();
    const glow = () => page.evaluate(() => getComputedStyle(document.body, "::before").display);
    expect(await glow()).not.toBe("none");
    // A print render painted the glow as a solid bright-blue oval over the
    // header and first card (2026-10-06).
    await page.emulateMedia({ media: "print" });
    expect(await glow()).toBe("none");
  });
});
