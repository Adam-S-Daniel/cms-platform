// @lane: local — exercises the locally-served 404 page; @parity-eligible via TARGET=
const { test, expect } = require("./base");

test.describe("404 page", () => {
  test("renders site header, footer, and a page-not-found message", async ({ page }) => {
    await page.goto("/404.html");

    await expect(page.locator(".site-header")).toBeVisible();
    await expect(page.locator(".site-footer")).toBeVisible();

    await expect(page.locator("main h1")).toHaveText(/404|not found/i);
    await expect(page.getByRole("link", { name: /home|homepage|back/i }).first()).toBeVisible();
  });

  test("responds with HTTP 404 for a missing page", async ({ page }) => {
    // allowed: literal slug used for known fixture (intentionally non-existent path)
    const response = await page.goto("/blog/this-page-does-not-exist/");
    expect(response.status()).toBe(404);
  });
});
