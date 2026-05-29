// @lane: local — exercises the locally-served /preview/ bridge between admin + Jekyll
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { captureStep } = require("./manual-capture");

// Unit-style tests for admin/preview-bridge.js against a stubbed window.CMS.
// This covers the bridge's contract — "register a postSave listener, and
// broadcast entry data on save" — without booting Decap, so it runs in
// under a second and is immune to Decap DOM churn. The companion
// admin-cms-preview.spec.js exercises the real editor integration.

const BRIDGE_PATH = path.join(__dirname, "..", "admin", "preview-bridge.js");

async function loadBridgeHarness(page) {
  const bridgeSrc = fs.readFileSync(BRIDGE_PATH, "utf8");
  // Serve a minimal HTML page over the Jekyll webserver's origin so
  // BroadcastChannel scoping lines up with what preview.html expects.
  await page.goto("/preview/"); // same-origin landing page
  await page.evaluate(
    ({ bridgeSrc }) => {
      // Wipe the preview listener installed by /preview/ — we want this
      // tab to be the "admin" side of the bridge, not a preview receiver.
      window.stop();

      // Stub a minimal Decap-compatible CMS global. registerEventListener
      // captures handlers; tests invoke them directly to simulate saves.
      window.__capturedListeners = {};
      window.CMS = {
        registerEventListener({ name, handler }) {
          window.__capturedListeners[name] = handler;
        },
      };

      // Load the bridge script.
      const s = document.createElement("script");
      s.textContent = bridgeSrc;
      document.body.appendChild(s);
    },
    { bridgeSrc },
  );
  // Allow the bridge's CMS-ready wait loop to observe window.CMS.
  await page.waitForFunction(() => typeof window.__capturedListeners?.postSave === "function", {
    timeout: 5000,
  });
}

test.describe(
  "admin preview bridge",
  // Tagged @admin-read: drives /admin/* but is read-only (DOM contract,
  // mocked APIs, byte parity, etc.). Runs on chromium-desktop-3k +
  // webkit-iphone16. See playwright.config.js.
  { tag: ["@admin-read"] },
  () => {
    test.beforeEach(async () => {});

    test("registers a postSave event listener with Decap", async ({ page }) => {
      await loadBridgeHarness(page);
      const registered = await page.evaluate(() => Object.keys(window.__capturedListeners));
      expect(registered).toContain("postSave");
    });

    test("postSave broadcasts entry data on the shared BroadcastChannel", async ({
      page,
      context,
    }) => {
      await loadBridgeHarness(page);

      // Open a listener tab on the same channel. Install the listener
      // SYNCHRONOUSLY and store the resolution Promise on window so there's
      // no race between channel-open and the sender's broadcast.
      const listener = await context.newPage();
      await listener.goto("/preview/");
      await listener.evaluate(() => {
        window.__ch = new BroadcastChannel("adamdaniel-cms-preview");
        window.__received = new Promise((resolve) => {
          window.__ch.addEventListener("message", (e) => {
            if (e.data?.type === "cms-preview-update") resolve(e.data);
          });
        });
      });

      // Simulate a save via the captured handler. The `entry` arg mirrors
      // Decap's shape: an Immutable-like Map with .get()/.getIn()/.toJS().
      await page.evaluate(() => {
        const mockEntry = {
          data: {
            title: "Broadcast me",
            body: "A draft body.",
            slug: "broadcast-me",
          },
          collection: "posts",
          get(key) {
            if (key === "data") {
              return {
                toJS: () => mockEntry.data,
              };
            }
            if (key === "collection") return mockEntry.collection;
            return undefined;
          },
        };
        window.__capturedListeners.postSave({ entry: mockEntry });
      });

      const msg = await listener.evaluate(() => window.__received);
      expect(msg.type).toBe("cms-preview-update");
      expect(msg.collection).toBe("posts");
      expect(msg.fields.title).toBe("Broadcast me");
      expect(msg.fields.body).toBe("A draft body.");
      await captureStep(listener, {
        section: "Real-layout preview",
        step: "4.1",
        title: "Live preview tab receives an edit",
        body: "Open `/preview/` in a second tab while editing. The bridge in `admin/preview-bridge.js` forwards every Save (or in-progress edit) over a same-origin BroadcastChannel; the preview tab renders the draft using the real Jekyll layout, so what you see matches the published post by construction.",
      });
      await listener.close();
    });

    test("exposes a helper that builds the preview URL for a collection", async ({ page }) => {
      await loadBridgeHarness(page);
      const url = await page.evaluate(() => window.adamdaniel_cms_preview_url("posts"));
      expect(url).toMatch(/\/preview\/\?collection=posts$/);

      const pagesUrl = await page.evaluate(() => window.adamdaniel_cms_preview_url("pages"));
      expect(pagesUrl).toMatch(/\/preview\/\?collection=pages$/);
    });
  },
);
