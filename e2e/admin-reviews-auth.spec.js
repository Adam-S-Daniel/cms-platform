// @lane: local — stubs window.open + GitHub OAuth handshake; never hits real GitHub
const { test, expect } = require("./base");

// Verifies the /admin/reviews/ dashboard actually completes the
// Decap/Netlify CMS OAuth handshake. The OAuth proxy
// (oauth-proxy/lambda.py) is the popup; before it'll send the access
// token, the opener must reply to its initial "authorizing:github"
// message with the same string. The previous listener only watched for
// `e.data.token`, never replied to the handshake, and the popup hung on
// "Completing authorisation…" forever.
//
// We can't drive a real GitHub OAuth flow from a unit test, so this
// stubs `window.open` to return a fake popup whose postMessage forwards
// to the opener — that's a faithful model of how the real popup
// communicates back across the same-origin window.opener bridge.

test.describe(
  "/admin/reviews/ OAuth handshake",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test("replies to authorizing handshake and stores the access token", async ({ page }) => {
      await page.addInitScript(() => {
        // Capture the popup the dashboard opens. The fake popup acts as
        // both sides: when the dashboard does popup.postMessage(...) we
        // record it (the "popup → opener handshake reply" path), and we
        // expose triggers so the test driver can pretend the popup is
        // posting messages back to the opener (window.dispatchEvent of a
        // MessageEvent).
        window.__popupMessages = [];
        window.__popupClosed = false;

        window.open = function (url) {
          window.__popupURL = String(url);
          const popup = {
            closed: false,
            location: { href: String(url) },
            postMessage(msg /* , targetOrigin */) {
              window.__popupMessages.push(msg);
            },
            close() {
              this.closed = true;
              window.__popupClosed = true;
            },
          };
          window.__popup = popup;
          return popup;
        };

        window.__simulatePopupMessage = function (data) {
          // The browser would deliver this via MessageEvent on the opener.
          // We can't set `source` to a plain object — Chromium rejects it —
          // and the dashboard's handler uses the closure-captured popup
          // reference rather than e.source, so omitting it is faithful.
          const event = new MessageEvent("message", {
            data,
            origin: "https://sq8d4876v8.execute-api.us-east-1.amazonaws.com",
          });
          window.dispatchEvent(event);
        };
      });

      // Make sure no leftover token hides the auth screen.
      await page.goto("/admin/reviews/");
      await page.evaluate(() => localStorage.removeItem("gh_reviews_token"));
      await page.reload();

      // Auth screen should be visible (no token in localStorage).
      await expect(page.locator("#auth-screen")).toBeVisible();
      await page.locator("#login-btn").click();

      // The popup should have been opened with the OAuth proxy URL.
      const popupURL = await page.evaluate(() => window.__popupURL);
      expect(popupURL).toContain("/prod/auth");

      // Step 1: the popup posts "authorizing:github" to the opener.
      // The opener MUST reply with the same string — that's the
      // Decap CMS handshake. Without the reply, the popup never
      // sends the token and stays stuck on "Completing authorisation…".
      await page.evaluate(() => window.__simulatePopupMessage("authorizing:github"));

      await expect
        .poll(() => page.evaluate(() => window.__popupMessages.length))
        .toBeGreaterThan(0);

      const handshakeReply = await page.evaluate(() => window.__popupMessages[0]);
      expect(handshakeReply).toBe("authorizing:github");

      // Step 2: the popup posts the success payload. The dashboard must
      // parse the token out of the Decap-format string ("authorization:
      // <provider>:success:<JSON>") and persist it.
      const token = "ghp_test_token_abc123";
      const payload = JSON.stringify({ token, provider: "github" });
      await page.evaluate(
        (data) => window.__simulatePopupMessage(data),
        `authorization:github:success:${payload}`,
      );

      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("gh_reviews_token")))
        .toBe(token);

      // The dashboard should also close the popup once it has the token.
      await expect.poll(() => page.evaluate(() => window.__popupClosed)).toBe(true);
    });
  },
);
