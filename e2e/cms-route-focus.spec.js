// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
  // Reload WITHOUT the hash. Decap lands on posts by itself, and a load that
  // already carries `#/collections/posts` starts single-entry-collection-shortcut.js's
  // 700 ms settle timer at first paint, before Decap has rendered: on a slow
  // runner it then finds the harness banner's one "Replacement test post 1"
  // link with no "+ New" link beside it, takes it for a one-entry collection
  // and jumps to an entry that does not exist, so the list never appears. Here
  // the shim only starts its timer on the hashchange Decap makes once rendered.
  await page.goto("/admin/index-test.html");
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.evaluate(() => {
    location.hash = "#/collections/posts";
  });
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
      // A fresh load starts sequential focus navigation at the top of the
      // document. Decap's own redirect after the load moved focus to the
      // heading, and blur() alone leaves the starting point there. Focusing
      // <body> itself puts it back at the top.
      await page.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
        document.body.removeAttribute("tabindex");
      });
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

// #342: Decap 3.15.1 keeps the previous entry's form/draft when one entry
// hash changes directly to another. The current Editor's Delete handler,
// however, receives the NEW route slug. These tests only inspect the handler
// and test-repo state; they never invoke Save, Publish, or Delete.
const FIRST = { slug: "2026-01-01-alpha", title: "Alpha" };
const SECOND = { slug: "2026-01-02-beta", title: "Beta" };
const DIAGNOSTIC_ORIGIN = "https://example.com";
const DECAP_PREFIX = "https://unpkg.com/decap-cms@3.15.1/dist/";
const SITE_ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");
const BUILT_SITE = path.join(SITE_ROOT, "_site");
const DECAP_DIST = path.join(__dirname, "node_modules", "decap-cms", "dist");

function entryRoute(entry) {
  return `#/collections/posts/entries/${entry.slug}`;
}

function diagnosticSeed() {
  const post = (entry, day) => ({
    content: `---\ntitle: ${entry.title}\nslug: ${entry.title.toLowerCase()}\ndate: 2026-01-${day}\n---\n${entry.title} body`,
  });
  return {
    _posts: {
      [`${FIRST.slug}.md`]: post(FIRST, "01"),
      [`${SECOND.slug}.md`]: post(SECOND, "02"),
    },
    _tags: {},
    _projects: {},
    pages: {},
  };
}

async function pinnedDecapScript() {
  const shell = fs.readFileSync(path.join(BUILT_SITE, "admin", "index.html"), "utf8");
  const { parse } = await import("parse5");
  const pinned = [];
  function visit(node) {
    if (node.tagName === "script") {
      const attrs = Object.fromEntries((node.attrs || []).map(({ name, value }) => [name, value]));
      if (attrs.src === `${DECAP_PREFIX}decap-cms.js`) pinned.push(attrs);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(shell));
  if (pinned.length !== 1 || !pinned[0].integrity) {
    throw new Error("Built admin shell lacks one pinned Decap 3.15.1 script with SRI");
  }
  const bundle = fs.readFileSync(path.join(DECAP_DIST, "decap-cms.js"));
  const digest = `sha384-${crypto.createHash("sha384").update(bundle).digest("base64")}`;
  expect(digest, "npm's Decap bundle must match the built admin's SRI").toBe(pinned[0].integrity);
  return `<script src="${DECAP_PREFIX}decap-cms.js" integrity="${digest}" crossorigin="anonymous"></script>`;
}

async function openDiagnosticAdmin(page, shell) {
  const script = await pinnedDecapScript();
  const seed = diagnosticSeed();
  const pageErrors = [];
  const unexpectedRequests = [];
  page.on("pageerror", (error) => pageErrors.push(error.stack || `${error.name}: ${error.message}`));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET") {
      unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
      await route.abort();
      return;
    }
    if (url.origin === DIAGNOSTIC_ORIGIN) {
      if (url.pathname === "/admin/issue-342-stock.html" && shell === "stock") {
        await route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<!doctype html><html><head><meta charset="utf-8"><link rel="cms-config-url" type="text/yaml" href="config-test.yml"></head><body>${script}</body></html>`,
        });
        return;
      }
      // The production shell is read from the SITE'S rendered assets, so
      // this browser spec also runs in a consumer without theme/admin source.
      const pathname = url.pathname === "/admin/config.yml" ? "/admin/config-test.yml" : url.pathname;
      const local = path.resolve(BUILT_SITE, `.${decodeURIComponent(pathname)}`);
      if (!local.startsWith(`${BUILT_SITE}${path.sep}`)) throw new Error("Admin asset escaped the built site");
      if (fs.existsSync(local) && fs.statSync(local).isFile()) {
        await route.fulfill({ path: local });
      } else {
        await route.fulfill({ status: 404, body: "" });
      }
      return;
    }
    if (request.url().startsWith(DECAP_PREFIX)) {
      const filename = path.basename(url.pathname);
      const local = path.join(DECAP_DIST, filename);
      if (fs.existsSync(local) && fs.statSync(local).isFile()) {
        await route.fulfill({ path: local });
        return;
      }
    }
    unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    await route.abort();
  });
  await page.addInitScript((files) => {
    window.repoFiles = files;
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  }, seed);
  const shellFile = shell === "stock" ? "issue-342-stock.html" : "index.html";
  await page.goto(`${DIAGNOSTIC_ORIGIN}/admin/${shellFile}`);
  await page.getByRole("button", { name: /login/i }).click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible();
  return { seed, pageErrors, unexpectedRequests };
}

async function editorSnapshot(page) {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((item) =>
      /Delete published entry/i.test(item.textContent || ""),
    );
    if (!button) return null;
    const fiberKey = Object.keys(button).find((key) => key.startsWith("__reactFiber$"));
    const propsKey = Object.keys(button).find((key) => key.startsWith("__reactProps$"));
    let fiber = fiberKey && button[fiberKey];
    while (fiber && typeof fiber.stateNode?.handleDeleteEntry !== "function") fiber = fiber.return;
    if (!fiber) return null;
    const editor = fiber.stateNode;
    const titleInput = document.querySelector('input[id*="title" i], input[placeholder*="title" i]');
    return {
      routeSlug: location.hash.split("/").at(-1),
      displayedTitle: titleInput?.value,
      draftSlug: editor.props.entryDraft?.getIn(["entry", "slug"]),
      draftTitle: editor.props.entryDraft?.getIn(["entry", "data", "title"]),
      actionCollection: editor.props.collection?.get("name"),
      actionSlug: editor.props.slug,
      deleteWired: !!propsKey && button[propsKey].onClick === editor.handleDeleteEntry,
    };
  });
}

async function assertEditor(page, entry) {
  await expect.poll(editorSnapshot.bind(null, page), { timeout: 30_000 }).toEqual({
    routeSlug: entry.slug,
    displayedTitle: entry.title,
    draftSlug: entry.slug,
    draftTitle: entry.title,
    actionCollection: "posts",
    actionSlug: entry.slug,
    deleteWired: true,
  });
}

test.describe("Decap entry route binding (#342)", { tag: ["@admin-read"] }, () => {
  test.describe.configure({ timeout: 90_000 });

  for (const shell of ["stock", "platform"]) {
    test(`${shell} shell: direct entry hash exposes the stale form and mismatched Delete target`, async ({ page }) => {
      const { seed, pageErrors, unexpectedRequests } = await openDiagnosticAdmin(page, shell);
      await page.evaluate((route) => { location.hash = route; }, entryRoute(FIRST));
      await assertEditor(page, FIRST);

      await page.evaluate((route) => { location.hash = route; }, entryRoute(SECOND));
      // Current Editor.props.slug is the handler's target. Waiting for it to
      // become SECOND is the router-commit barrier; hash alone is too early.
      await expect.poll(async () => (await editorSnapshot(page))?.actionSlug).toBe(SECOND.slug);
      const state = await editorSnapshot(page);
      expect(state).toEqual({
        routeSlug: SECOND.slug,
        displayedTitle: FIRST.title,
        draftSlug: FIRST.slug,
        draftTitle: FIRST.title,
        actionCollection: "posts",
        actionSlug: SECOND.slug,
        deleteWired: true,
      });
      expect(await page.evaluate(() => window.repoFiles)).toEqual(seed);
      expect(pageErrors, `pageerror stack(s): ${pageErrors.join("\n")}`).toEqual([]);
      expect(unexpectedRequests).toEqual([]);

      // Known upstream defect. Only this final agreement assertion is
      // expected to fail; setup, handler wiring, and observed divergence
      // above must all pass or the test remains a real failure.
      test.fail();
      expect(state).toMatchObject({ displayedTitle: SECOND.title, draftSlug: SECOND.slug });
    });
  }

  test("collection intermediary binds route, form, and Delete to the second entry", async ({ page }) => {
    const { seed, pageErrors, unexpectedRequests } = await openDiagnosticAdmin(page, "platform");
    await page.evaluate((route) => { location.hash = route; }, entryRoute(FIRST));
    await assertEditor(page, FIRST);
    await page.evaluate(() => { location.hash = "#/collections/posts"; });
    await expect(page.locator(EDITOR)).toHaveCount(0);
    await page.evaluate((route) => { location.hash = route; }, entryRoute(SECOND));
    await assertEditor(page, SECOND);
    expect(await page.evaluate(() => window.repoFiles)).toEqual(seed);
    expect(pageErrors, `pageerror stack(s): ${pageErrors.join("\n")}`).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });

  test("full reload binds route, form, and Delete to the second entry", async ({ page }) => {
    const { seed, pageErrors, unexpectedRequests } = await openDiagnosticAdmin(page, "platform");
    await page.evaluate((route) => { location.hash = route; }, entryRoute(FIRST));
    await assertEditor(page, FIRST);
    await page.evaluate((route) => { location.hash = route; }, entryRoute(SECOND));
    await page.reload();
    await assertEditor(page, SECOND);
    expect(await page.evaluate(() => window.repoFiles)).toEqual(seed);
    expect(pageErrors, `pageerror stack(s): ${pageErrors.join("\n")}`).toEqual([]);
    expect(unexpectedRequests).toEqual([]);
  });
});
