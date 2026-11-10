// @lane: local — mocks every GitHub API request via page.route; the "approval" it sends goes to a route handler, never to GitHub
const { test, expect } = require("./base");

// /admin/reviews/ Approve gave no lasting feedback (cms-platform#911): the card
// still read "Awaiting Review" after a successful approval (the immediate
// reload still listed the run as waiting), Approve stayed enabled so a second
// tap sent a second POST, and GitHub's 422 for an already-decided gate showed
// as "Failed: Validation Failed". Every GitHub call is mocked.

const FAKE_TOKEN = "ghp_fake_token_for_decision_test";
const PR_NUMBER = 4120;
const SHA = "cad83730000000000000000000000000000000aa";
const RUN = 37464002671;
const VR_PATH = ".github/workflows/visual-regression.yml";

// `postStatus` is what the pending_deployments POST answers; `runStatus` is the
// status of GET /actions/runs/{id}, which the dashboard re-checks after a 422.
async function installMocks(page, { postStatus, runStatus = "waiting" }) {
  const posts = [];
  await page.addInitScript((token) => {
    localStorage.setItem("gh_reviews_token", token);
  }, FAKE_TOKEN);
  await page.route("https://api.github.com/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (req.method() === "POST") {
      posts.push(path);
      return json(postStatus === 200 ? [{}] : { message: "Validation Failed" }, postStatus);
    }
    if (path === "/user") return json({ login: "decision-spec-user" });
    if (path.endsWith("/actions/runs")) {
      // Always still "waiting": the lag the issue describes.
      return json({ workflow_runs: [{ id: RUN, path: VR_PATH, head_sha: SHA, pull_requests: [{ number: PR_NUMBER }] }] });
    }
    if (path.endsWith(`/actions/runs/${RUN}`)) return json({ id: RUN, status: runStatus });
    if (path.endsWith("/pending_deployments")) return json([{ environment: { id: 11 } }]);
    if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
      return json({ title: "Decision feedback", head: { ref: "fix/decision", sha: SHA } });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  await page.route(/^https:\/\/preview-pr\d+\./, (route) => route.fulfill({ status: 404, body: "" }));
  return posts;
}

test.describe("/admin/reviews/ decision feedback", { tag: ["@admin-read"] }, () => {
  test("a successful approval marks the card and a second tap sends nothing", async ({ page }) => {
    const posts = await installMocks(page, { postStatus: 200 });
    await page.goto("/admin/reviews/");
    const card = page.locator(`.review-card[data-run-id="${RUN}"]`);
    const approve = card.getByRole("button", { name: "Approve" });
    await expect(approve).toBeVisible();

    await approve.click();
    await expect(card.locator(".status-badge")).toHaveText("Approved");
    await expect(approve).toBeDisabled();
    await expect(card.getByRole("button", { name: "Request Changes" })).toBeDisabled();
    await approve.click({ force: true });
    expect(posts).toHaveLength(1);
  });

  test("a 422 on a gate that is no longer waiting reads Already decided, not Failed", async ({ page }) => {
    await installMocks(page, { postStatus: 422, runStatus: "in_progress" });
    await page.goto("/admin/reviews/");
    const card = page.locator(`.review-card[data-run-id="${RUN}"]`);
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card.locator(".status-badge")).toHaveText("Already decided");
    await expect(page.locator("body")).not.toContainText("Failed: Validation Failed");
  });

  test("a failure on a run that still waits re-enables the buttons", async ({ page }) => {
    await installMocks(page, { postStatus: 422, runStatus: "waiting" });
    await page.goto("/admin/reviews/");
    const card = page.locator(`.review-card[data-run-id="${RUN}"]`);
    const approve = card.getByRole("button", { name: "Approve" });
    await approve.click();
    await expect(page.locator("body")).toContainText("Failed: Validation Failed");
    await expect(approve).toBeEnabled();
    await expect(card.locator(".status-badge")).toHaveText("Awaiting Review");
  });
});
