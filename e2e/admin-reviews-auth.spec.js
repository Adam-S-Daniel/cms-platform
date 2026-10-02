// @lane: local — stubs window.open + GitHub OAuth handshake; never hits real GitHub
const { test, expect } = require("./base");

// Verifies the /admin/reviews/ and /admin/reviews/health.html dashboards
// complete the Decap/Netlify CMS OAuth handshake, and ONLY with the OAuth
// proxy's popup. The proxy (oauth-proxy/lambda.py) serves the popup; before it
// sends the access token, the opener must reply to its initial
// "authorizing:github" message with the same string. The previous listener
// only watched for `e.data.token`, never replied to the handshake, and the
// popup hung on "Completing authorisation…" forever.
//
// The dashboards' listener now accepts a login message only when it comes from
// the OAuth proxy's origin AND from the popup window this page opened, and it
// addresses its handshake reply to that origin (never "*" or e.origin). So the
// fake popup must be a REAL WindowProxy — `e.source` is compared with the
// window.open() return value, and a plain object can neither be that nor be a
// MessageEvent source. We get one from a hidden same-origin iframe, and replace
// its postMessage/close with recorders.
//
// We can't drive a real GitHub OAuth flow from a unit test, so the popup is
// stubbed and every message is dispatched by hand; the dashboards' follow-up
// GitHub API calls are aborted so the spec never touches the network. The OAuth
// origin is derived from the URL the page passed to window.open(): sites differ
// (on the fixture site cms.oauth_base_url is empty, so it is the page's own).

const TOKEN_KEY = "gh_reviews_token";
const ATTACKER_ORIGIN = "https://attacker.example.net";
const HANDSHAKE = "authorizing:github";
const FAKE_TOKEN = "TEST-TOKEN-VALUE";
const SUCCESS_MESSAGE = `authorization:github:success:${JSON.stringify({
  token: FAKE_TOKEN,
  provider: "github",
})}`;

// Both dashboards carry the same login handler; run the same cases on each.
const DASHBOARDS = ["/admin/reviews/", "/admin/reviews/health.html"];

async function installPopupStub(page) {
  // The dashboards fetch api.github.com once signed in; cut it off so a
  // successful login in this spec stays hermetic.
  await page.route("https://api.github.com/**", (route) => route.abort());

  await page.addInitScript(() => {
    // Capture the popup the dashboard opens. The fake popup records what the
    // dashboard sends it (the "opener → popup handshake reply" path), and
    // __simulatePopupMessage pretends the popup posted to the opener.
    window.__popupMessages = []; // [{ msg, targetOrigin }]
    window.__popupClosed = false;

    window.open = function (url) {
      window.__popupURL = String(url);
      // Created lazily: document.body does not exist at init-script time. No
      // `src` — an iframe left at its initial about:blank keeps its Window.
      const iframe = document.createElement("iframe");
      iframe.hidden = true;
      document.body.appendChild(iframe);
      const popup = iframe.contentWindow;
      popup.postMessage = function (msg, targetOrigin) {
        window.__popupMessages.push({ msg, targetOrigin });
      };
      popup.close = function () {
        window.__popupClosed = true;
      };
      window.__popup = popup;
      return popup;
    };

    // The browser would deliver this via a MessageEvent on the opener.
    // `origin` defaults to the OAuth proxy's (the popup URL's origin) and
    // `source` to the popup; opts can override either to play an impostor.
    window.__simulatePopupMessage = function (data, opts = {}) {
      const origin =
        "origin" in opts ? opts.origin : new URL(window.__popupURL, location.href).origin;
      const source = "source" in opts ? opts.source : window.__popup;
      // dispatchEvent is synchronous: the dashboard's listener has run on return.
      window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
    };

    window.__snapshot = function () {
      return {
        replies: window.__popupMessages.length,
        token: localStorage.getItem("gh_reviews_token"),
        closed: window.__popupClosed,
      };
    };
  });
}

// Load a dashboard signed out and click "Sign in with GitHub".
async function openLoginPopup(page, dashboardPath) {
  // Make sure no leftover token hides the auth screen.
  await page.goto(dashboardPath);
  await page.evaluate((key) => localStorage.removeItem(key), TOKEN_KEY);
  await page.reload();

  // Auth screen should be visible (no token in localStorage).
  await expect(page.locator("#auth-screen")).toBeVisible();
  await page.locator("#login-btn").click();

  // The popup should have been opened with the OAuth proxy URL.
  const popupURL = await page.evaluate(() => window.__popupURL);
  expect(popupURL).toContain("/prod/auth");
}

test.describe(
  "/admin/reviews/ OAuth handshake",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    for (const dashboardPath of DASHBOARDS) {
      test(`${dashboardPath} replies to authorizing handshake and stores the access token`, async ({
        page,
      }) => {
        await installPopupStub(page);
        await openLoginPopup(page, dashboardPath);

        // Step 1: the popup posts "authorizing:github" to the opener.
        // The opener MUST reply with the same string — that's the
        // Decap CMS handshake. Without the reply, the popup never
        // sends the token and stays stuck on "Completing authorisation…".
        await page.evaluate((data) => window.__simulatePopupMessage(data), HANDSHAKE);

        await expect
          .poll(() => page.evaluate(() => window.__popupMessages.length))
          .toBeGreaterThan(0);

        const handshakeReply = await page.evaluate(() => window.__popupMessages[0]);
        expect(handshakeReply.msg).toBe(HANDSHAKE);
        // The reply is addressed to the OAuth proxy's origin — never "*".
        const oauthOrigin = await page.evaluate(
          () => new URL(window.__popupURL, location.href).origin,
        );
        expect(handshakeReply.targetOrigin).toBe(oauthOrigin);

        // Step 2: the popup posts the success payload. The dashboard must
        // parse the token out of the Decap-format string ("authorization:
        // <provider>:success:<JSON>") and persist it.
        await page.evaluate((data) => window.__simulatePopupMessage(data), SUCCESS_MESSAGE);

        await expect
          .poll(() => page.evaluate((key) => localStorage.getItem(key), TOKEN_KEY))
          .toBe(FAKE_TOKEN);

        // The dashboard should also close the popup once it has the token.
        await expect.poll(() => page.evaluate(() => window.__popupClosed)).toBe(true);
      });

      // The two cases below share a shape: an impostor posts both the handshake
      // and the success payload and must get NOTHING — no reply, no stored
      // token, popup left open. Each ends with a control: the same listener
      // still answers the genuine popup, so the silence above came from the
      // origin/source check and not from a listener that never attached.
      for (const [label, impostor] of [
        ["WRONG ORIGIN (right window)", { origin: ATTACKER_ORIGIN }],
        ["WRONG SOURCE (right origin)", { source: "this-window" }],
      ]) {
        test(`${dashboardPath} ignores a handshake and token from the ${label}`, async ({
          page,
        }) => {
          await installPopupStub(page);
          await openLoginPopup(page, dashboardPath);

          const impostorOutcome = await page.evaluate(
            ({ handshake, success, impostor: who }) => {
              const opts = { ...who };
              // A window object can't cross the evaluate boundary; name it.
              if (opts.source === "this-window") opts.source = window;
              window.__simulatePopupMessage(handshake, opts);
              window.__simulatePopupMessage(success, opts);
              return window.__snapshot();
            },
            { handshake: HANDSHAKE, success: SUCCESS_MESSAGE, impostor },
          );
          expect(impostorOutcome).toEqual({ replies: 0, token: null, closed: false });

          const afterGenuine = await page.evaluate((data) => {
            window.__simulatePopupMessage(data);
            return window.__snapshot();
          }, HANDSHAKE);
          expect(afterGenuine.replies).toBe(1);
        });
      }
    }
  },
);
