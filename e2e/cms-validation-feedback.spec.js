// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (cms-platform#730) ───────────────────────────────────
// A field `pattern` failure blocks Save, and Decap raises its toast only for
// a MISSING value. admin/validation-feedback.js adds the missing feedback (a
// toast plus a scroll to the first bad field), says the site's message alone
// in normal case, and must not double up with Decap's own toast, outlive a
// save that went through, or fire on merely opening the Publish menu. The
// unit half (vm sandbox) is validation-feedback.test.js; this is the half a
// stand-in cannot give: the real Decap bundle, real clicks, real error DOM.
//
// Harness: index-test.html (Decap's in-browser test-repo backend,
// editorial_workflow). The Pages collection's `permalink` carries a pattern
// (config-test.yml), and `title`, `permalink` and `body` are required, so a
// missing body gives Decap's own PRESENCE toast. Seed/login pattern mirrors
// cms-tags-input.spec.js.

const SHIM_TOAST = "[data-validation-feedback-toast]";
const FIELD_ERRORS = '[class*="ControlErrorsList"]';

// Replace the Permalink value outright. CI (chromium-desktop-3k, run
// 37403111175) saw a plain fill() over "bad" leave "bad/pages/validation-
// feedback/" in the box. Likely cause (not reproduced locally): fill() selects
// the old text and then inserts, and a Decap re-render landing between the two
// would collapse the selection, so the insert appends. Select-all + Delete is
// a keystroke Decap handles like any edit, and the toHaveValue checks retry
// until the box holds exactly what was asked for, so a half-applied edit fails
// here and not later at the save.
async function setPermalink(page, value) {
  const field = page.getByLabel(/^Permalink$/);
  await field.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Delete");
  await expect(field).toHaveValue("");
  await field.fill(value);
  await expect(field).toHaveValue(value);
}

// Appended to config-test.yml for the #750 tests only (Pages is its last
// collection, so these are its last fields): a list whose rows carry a
// pattern field, and a last field that cannot scroll any higher, which is
// where the toast used to sit on top of it.
const EXTRA_FIELDS = `
      - name: links
        label: Links
        widget: list
        required: false
        summary: "{{fields.label}}"
        fields:
          - { name: label, label: "Link label", widget: string }
          - { name: url, label: URL, widget: string, pattern: ["^https?://", "Must be an http(s) URL"] }
      - name: last_link
        label: Last link
        widget: string
        required: false
        pattern: ["^https?://", "Must be an http(s) URL"]
`;

async function fillBody(page) {
  const editor = page.locator('[role="textbox"][contenteditable="true"]').last();
  await editor.click();
  await editor.pressSequentially("Body text.");
}

async function openNewPage(page, { body, extraFields = false }) {
  if (extraFields) {
    await page.route(/\/admin\/config-test\.yml$/, async (route) => {
      const res = await route.fetch();
      await route.fulfill({ status: 200, contentType: "text/yaml", body: (await res.text()) + EXTRA_FIELDS });
    });
  }
  await page.addInitScript(() => {
    window.repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  page.on("pageerror", (err) => console.log(`[pageerror] ${err.name}: ${err.message}`));
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^pages$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/pages/new");
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel(/^Title$/).fill("Validation feedback check");
  await setPermalink(page, "bad");
  if (body) await fillBody(page);
}

const saveButton = (page) => page.getByRole("button", { name: /^save$/i }).first();

// A finished save is Decap's "Entry saved" toast (ui.toast.entrySaved, raised
// after the backend write, 3.15.1). Not the Save button: Decap marks it
// disabled with a CSS class only, never the `disabled` attribute.
const expectSaved = (page) => expect(page.getByText("Entry saved", { exact: true })).toBeVisible({ timeout: 30_000 });

// Let the shim's own settle frames run, so "nothing appeared" is a statement
// about a finished check and not about one that has not started yet.
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        let n = 8;
        const tick = () => (--n > 0 ? requestAnimationFrame(tick) : resolve());
        requestAnimationFrame(tick);
      }),
  );

test.describe(
  "A blocked Save says why, and says it once (#730)",
  // Tagged @admin-write: drives /admin/* and writes an editorial draft.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });

    test("a pattern-only failure on Save toasts the site's message and scrolls to the field", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 420 });
      await openNewPage(page, { body: true });
      await saveButton(page).click();

      const toast = page.locator(SHIM_TOAST);
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toContainText(/^Not saved yet\. Permalink: Must start and end with a slash/);
      // Decap raised nothing of its own: this is the gap the shim fills.
      await expect(page.getByText(/missed a required field/i)).toHaveCount(0);

      const error = page.locator(FIELD_ERRORS).first();
      await expect(error).toBeInViewport();
      await expect(error).toContainText(/^Permalink: Must start and end with a slash/);
      await expect(error).not.toContainText(/didn't match the pattern/i);
      await expect(error).toHaveCSS("text-transform", "none");
    });

    test("a missing required field gets Decap's own toast and no second one", async ({ page }) => {
      await openNewPage(page, { body: false });
      await saveButton(page).click();
      await expect(page.getByText(/missed a required field/i)).toBeVisible({ timeout: 15_000 });
      await settle(page);
      await expect(page.locator(SHIM_TOAST)).toHaveCount(0);
    });

    test("fixing the field and saving again leaves no stale 'Not saved yet'", async ({ page }) => {
      await openNewPage(page, { body: true });
      await saveButton(page).click();
      await expect(page.locator(SHIM_TOAST)).toBeVisible({ timeout: 15_000 });

      await setPermalink(page, "/pages/validation-feedback/");
      // The toast is still up when the second Save is clicked (it self-removes
      // after 10 s), so what removes it below is the shim's own report(), not
      // its timer; otherwise the final "gone" check could pass vacuously.
      await expect(page.locator(SHIM_TOAST)).toBeVisible();
      await saveButton(page).click();
      await expectSaved(page);
      // Gone well inside the 10 s self-removal.
      await expect(page.locator(SHIM_TOAST)).toHaveCount(0, { timeout: 3_000 });
      await settle(page);
      await expect(page.locator(SHIM_TOAST)).toHaveCount(0);
    });

    test("opening the Publish menu is not a publish attempt", async ({ page }) => {
      await openNewPage(page, { body: true });
      await setPermalink(page, "/pages/validation-feedback/");
      await saveButton(page).click();
      await expectSaved(page);

      // Decap's Publish control is a menu trigger, shown once the entry is saved.
      const publish = page.getByRole("button", { name: /^publish/i }).first();
      await expect(publish).toBeVisible({ timeout: 30_000 });
      // A field error list left on screen, as one a failed attempt leaves
      // behind: without the guard, the click below would toast about it.
      await page.evaluate(() => {
        const ul = document.createElement("ul");
        ul.className = "css-stale-ControlErrorsList";
        ul.textContent = "Permalink: stale error from an earlier attempt";
        document.body.appendChild(ul);
      });
      await publish.click();
      await expect(page.getByRole("menuitem").first()).toBeVisible({ timeout: 15_000 });
      await settle(page);
      await expect(page.locator(SHIM_TOAST)).toHaveCount(0);
    });

    // ── cms-platform#750 ──────────────────────────────────────────────────

    test("a format error retried while Decap's earlier toast is up is not called a missing field", async ({
      page,
    }) => {
      // Decap raises "you've missed a required field" for an EMPTY required
      // field and keeps it for 8 s. Fixing that and retrying inside the 8 s
      // used to find the leftover toast, and the shim stood down: the editor
      // read "missed a required field" for a bad format.
      await openNewPage(page, { body: false });
      await saveButton(page).click();
      const missed = page.getByText(/missed a required field/i);
      await expect(missed).toBeVisible({ timeout: 15_000 });

      await fillBody(page);
      // Still up at the retry, or the check below would prove nothing.
      await expect(missed).toBeVisible();
      await saveButton(page).click();

      const toast = page.locator(SHIM_TOAST);
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toContainText(/^Not saved yet\. Permalink: Must start and end with a slash/);
      // Closed by the shim, well inside its own 8 s.
      await expect(missed).toHaveCount(0, { timeout: 3_000 });
    });

    test("the toast leaves the field it names uncovered, lets clicks through, and can be dismissed", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1280, height: 420 });
      await openNewPage(page, { body: true, extraFields: true });
      await setPermalink(page, "/pages/validation-feedback/");
      // The form's last field: the one `scrollIntoView` cannot lift any higher.
      const last = page.getByLabel(/^Last link/);
      await last.fill("not a url");
      await saveButton(page).click();

      const toast = page.locator(SHIM_TOAST);
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toContainText(/^Not saved yet\. Last link: Must be an http\(s\) URL/);
      await expect(last).toBeInViewport();

      const field = await last.boundingBox();
      const note = await toast.boundingBox();
      const overlaps =
        note.x < field.x + field.width &&
        field.x < note.x + note.width &&
        note.y < field.y + field.height &&
        field.y < note.y + note.height;
      expect(overlaps, `toast ${JSON.stringify(note)} covers field ${JSON.stringify(field)}`).toBe(false);

      // A click aimed at the field lands in it, whatever the toast is doing.
      await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
      await expect(last).toBeFocused();

      await toast.getByRole("button", { name: "Dismiss" }).click();
      await expect(toast).toHaveCount(0);
    });

    test("an error in a list row names the row and opens it", async ({ page }) => {
      await openNewPage(page, { body: true, extraFields: true });
      await setPermalink(page, "/pages/validation-feedback/");
      const addRow = page.getByRole("button", { name: /add links/i });
      await addRow.click();
      await page.getByLabel(/^Link label$/).fill("Alpha");
      await page.getByLabel(/^URL$/).fill("https://example.com/");
      await addRow.click();
      await page.getByLabel(/^Link label$/).last().fill("Beta");
      await page.getByLabel(/^URL$/).last().fill("bad address");

      // Collapse both rows, as an editor tidying a long list would.
      const rows = page.locator('[class*="SortableListItem"]');
      await rows.nth(1).locator("button").first().click();
      await rows.nth(0).locator("button").first().click();
      await expect(page.getByLabel(/^URL$/).last()).toBeHidden();

      await saveButton(page).click();
      const toast = page.locator(SHIM_TOAST);
      await expect(toast).toBeVisible({ timeout: 15_000 });
      await expect(toast).toContainText(/^Not saved yet\. Item 2 \(Beta\): URL: Must be an http\(s\) URL/);
      // The row the message is about is open; the good row stays shut.
      await expect(page.getByLabel(/^URL$/).last()).toBeVisible();
      await expect(page.getByLabel(/^URL$/).first()).toBeHidden();
    });
  },
);
