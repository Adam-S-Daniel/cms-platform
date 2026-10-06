// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (UX round 3: ad-kbd K8, jd-kbd F5) ───────────────────
// Decap unmounts the focused element on a route change, a Save and a Delete,
// so focus fell to <body>: after Enter on a list entry the next Tab went to
// "Search all", after Back it restarted at the top, and there was no skip
// link. admin/route-focus.js puts focus on the new view and adds a "Skip to
// content" link. The unit half (vm sandbox, stubbed frames) is
// route-focus.test.js; this is the half a stand-in cannot give: the real
// Decap 3.15.1 DOM those selectors were taken from, and real key presses.
//
// Harness: index-test.html (Decap's in-browser test-repo backend), one seeded
// post so the list has an entry to press Enter on. Seed/login pattern mirrors
// cms-tags-input.spec.js.

const EDITOR = '[class*="EditorContainer"]';
const BACK_LINK = 'a[class*="ToolbarSectionBackLink"]';
const ENTRY_LINK = 'a[class*="ListCardLink"]';

async function openList(page) {
  await page.addInitScript(() => {
    window.repoFiles = {
      _posts: { "2026-01-01-hello.md": { content: "---\ntitle: Hello\nslug: hello\ndate: 2026-01-01\n---\nBody" } },
      _tags: {},
      _projects: {},
      pages: {},
    };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/posts");
  await expect(page.locator(ENTRY_LINK).first()).toBeVisible({ timeout: 60_000 });
}

// Where focus is, as a description a failure message can print.
const where = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    return `${a.tagName.toLowerCase()}${a.id ? "#" + a.id : ""} "${String(a.getAttribute("aria-label") || a.textContent || "").trim().slice(0, 40)}"`;
  });

const focusIsIn = (page, selector) =>
  page.evaluate((sel) => !!(document.activeElement && document.activeElement.closest(sel)), selector);

test.describe(
  "Admin focus management and skip link",
  // Tagged @admin-write: drives /admin/* (it saves an editorial draft).
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("Enter on a list entry lands focus in the editor, so the next Tab stays there", async ({ page }) => {
      await openList(page);
      await page.locator(ENTRY_LINK).first().focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
      await expect(page.locator(BACK_LINK), "focus is on the editor's Back link, not body").toBeFocused();

      await page.keyboard.press("Tab");
      expect(await focusIsIn(page, EDITOR), `Tab stayed inside the editor (focus: ${await where(page)})`).toBe(true);
    });

    test("Back returns focus to the list heading, and Tab continues from there", async ({ page }) => {
      await openList(page);
      await page.locator(ENTRY_LINK).first().focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(BACK_LINK)).toBeFocused({ timeout: 30_000 });

      await page.keyboard.press("Enter");
      await expect(page.locator("main h1")).toBeFocused({ timeout: 30_000 });
      await expect(page.locator("main h1")).toHaveText("Posts");

      await page.keyboard.press("Tab");
      expect(await focusIsIn(page, "main"), `Tab continued inside the list (focus: ${await where(page)})`).toBe(true);
    });

    test("+ New puts focus in the first field of the new entry", async ({ page }) => {
      await openList(page);
      await page.locator('a[class*="CollectionTopNewButton"]').click();
      await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByLabel(/^Title$/)).toBeFocused();
    });

    test("the skip link is the first Tab stop, moves focus to the content and leaves the route alone", async ({ page }) => {
      await openList(page);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Skip to content" });
      await expect(skip).toBeFocused();
      await expect(skip, "visible while focused").toBeInViewport();

      await page.keyboard.press("Enter");
      await expect(page.locator("main h1")).toBeFocused();
      expect(new URL(page.url()).hash).toBe("#/collections/posts");

      // In an editor "content" is the form.
      await page.locator(ENTRY_LINK).first().focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
      // (Reachability by Tab is the first half; blur() would leave the
      // browser's sequential start point at the Back link, so focus it directly.)
      await skip.focus();
      await page.keyboard.press("Enter");
      expect(await focusIsIn(page, EDITOR), `skip link reached the form (focus: ${await where(page)})`).toBe(true);
      expect(await page.evaluate(() => document.activeElement.matches("input, textarea, [contenteditable]"))).toBe(true);
    });

    test("after a Save from the keyboard focus stays in the editor, not on body", async ({ page }) => {
      await openList(page);
      await page.locator('a[class*="CollectionTopNewButton"]').click();
      await page.getByLabel(/^Title$/).fill("Route focus check");
      const body = page.locator('[role="textbox"][contenteditable="true"]').last();
      await body.click();
      await body.pressSequentially("Body text.");

      const save = page.getByRole("button", { name: /^save$/i }).first();
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Entry saved", { exact: true })).toBeVisible({ timeout: 30_000 });
      // Decap disables the Save button it just activated, which drops focus on
      // body; the shim moves it back into the editor.
      await expect
        .poll(async () => ({ inEditor: await focusIsIn(page, EDITOR), at: await where(page) }), { timeout: 15_000 })
        .toMatchObject({ inEditor: true });
    });
  },
);
