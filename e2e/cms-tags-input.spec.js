// @lane: local — drives the in-browser test-repo Decap admin (index-test.html); no network, no GitHub
const { test, expect } = require("./base");

// ── What this proves (cms-platform#638) ───────────────────────────────────
// Posts' Tags is Decap's plain `list` widget: one text box split on commas.
// Out of the box, `alpha, beta` saved ONE tag `alphabeta` (Decap rewrites the
// box to "alpha, " after the comma and the editor's own space then makes it
// drop the comma), and Enter — which the hint promised — did nothing, so
// `one<Enter>two` saved `onetwo`. admin/tags-input.js fixes both. This spec is
// the half a stand-in cannot give: the real Decap editor, real key presses, and
// the real front matter Decap writes.
//
// Harness: index-test.html (Decap's in-browser test-repo backend,
// editorial_workflow); a Save lands as an editorial draft whose
// `diffs[0].content` is the exact file text Decap would commit. Seed/login
// pattern mirrors cms-slug-pin.spec.js.

// A site's tags index (`/tags/`): the page tags-input.js reads for the tags that
// already exist (#735). Mocked, so the spec does not depend on the site's posts.
async function mockTagsIndex(page, names) {
  await page.route("**/tags/", (route) =>
    names
      ? route.fulfill({
          contentType: "text/html",
          body:
            "<ul class='tag-list'>" +
            names.map((n) => `<li class='tag-list-item'><a class='tag-list-link' href='#'><span class='tag-list-name'>${n}</span></a></li>`).join("") +
            "</ul>",
        })
      : route.fulfill({ status: 404, contentType: "text/html", body: "Not found" }),
  );
}

// Any uncaught page error fails the test: a handler that throws inside the
// editor (e.g. a re-entrant re-render) must not pass unnoticed.
let pageErrors = [];

async function openNewPost(page) {
  await page.addInitScript(() => {
    window.repoFiles = { _posts: {}, _tags: {}, _projects: {}, pages: {} };
    window.repoFilesUnpublished = [];
    window.__AUTOSAVE_IDLE_MS = 3_600_000;
  });
  page.on("pageerror", (err) => {
    console.log(`[pageerror] ${err.name}: ${err.message}`);
    pageErrors.push(`${err.name}: ${err.message}`);
  });
  await page.goto("/admin/index-test.html");
  const loginBtn = page.getByRole("button", { name: /login/i });
  await expect(loginBtn).toBeVisible({ timeout: 60_000 });
  await loginBtn.click();
  await expect(page.getByRole("link", { name: /^posts$/i })).toBeVisible({ timeout: 30_000 });
  await page.goto("/admin/index-test.html#/collections/posts/new");
  await expect(page.getByLabel(/^Title$/)).toBeVisible({ timeout: 60_000 });
  await page.getByLabel(/^Title$/).fill("Tags input check");
  const body = page.locator('[role="textbox"][contenteditable="true"]').last();
  await body.click();
  await body.pressSequentially("Body text.");
}

async function savedTags(page) {
  await page.getByRole("button", { name: /^save$/i }).first().click();
  await expect(page.getByRole("button", { name: /^save$/i }).first()).toBeDisabled({ timeout: 30_000 });
  const text = await page.evaluate(() => {
    for (const entry of Object.values(window.repoFilesUnpublished || {})) {
      if (entry && entry.diffs && entry.diffs.length) return entry.diffs[0].content;
    }
    return "";
  });
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  expect(fm, `a saved post with front matter (got: ${text.slice(0, 80)})`).toBeTruthy();
  const lines = fm[1].split("\n");
  const at = lines.findIndex((l) => /^tags:/.test(l));
  expect(at, "a tags key in the saved front matter").toBeGreaterThanOrEqual(0);
  const inline = /^tags:\s*\[(.*)\]\s*$/.exec(lines[at]);
  if (inline) return inline[1].split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, ""));
  const out = [];
  for (let i = at + 1; i < lines.length && /^\s*-\s/.test(lines[i]); i++) {
    out.push(lines[i].replace(/^\s*-\s*/, "").replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

test.describe(
  "CMS Tags box splits on comma-space and on Enter (#638)",
  // Tagged @admin-write: drives /admin/* and writes an editorial draft.
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ mode: "serial", timeout: 180_000 });
    test.beforeEach(() => {
      pageErrors = [];
    });
    test.afterEach(() => {
      expect(pageErrors, "no uncaught page errors").toEqual([]);
    });

    test("typing `a, b` saves two tags", async ({ page }) => {
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("alpha, beta");
      expect(await savedTags(page)).toEqual(["alpha", "beta"]);
    });

    test("Enter ends a tag, and the hint does not promise more than that", async ({ page }) => {
      await openNewPost(page);
      await expect(page.getByText(/press Enter, or separate tags with commas/)).toBeVisible();
      await expect(page.getByText(/auto_tag_pages/)).toHaveCount(0);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("zz-test");
      await tags.press("Enter");
      await tags.pressSequentially("ai");
      expect(await savedTags(page)).toEqual(["zz-test", "ai"]);
    });

    test("typing `quo` offers the existing tag `quotes`, and picking it saves exactly that (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes", "release"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quo");
      const offer = page.locator("#cms-tags-suggest").getByRole("button", { name: "quotes", exact: true });
      await expect(offer).toBeVisible();
      await offer.click();
      expect(await savedTags(page)).toEqual(["quotes"]);
    });

    test("`quote` beside existing `quotes` is warned about, never rewritten on its own (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quote");
      const panel = page.locator("#cms-tags-suggest");
      await expect(panel).toContainText("\u201cquote\u201d is a new tag that is nearly identical to the existing tag \u201cquotes\u201d");
      await expect(panel.getByRole("button", { name: "Use \u201cquotes\u201d" })).toBeVisible();
      // Left alone, the editor's own spelling is saved: nothing was changed behind their back.
      expect(await savedTags(page)).toEqual(["quote"]);
    });

    test("the warning's button swaps `Quotes` for the existing `quotes` (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("Quotes");
      await page.locator("#cms-tags-suggest").getByRole("button", { name: "Use \u201cquotes\u201d" }).click();
      expect(await savedTags(page)).toEqual(["quotes"]);
    });

    // Keyboard path: the offer must be reachable with Tab and applied with Enter.
    // The focusout re-render once rebuilt every button, including the one about to
    // take focus, so Tab landed on <body> and Enter did nothing.
    test("Tab from `quote` reaches the `Use \u201cquotes\u201d` button and Enter applies it (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quote");
      const offer = page.locator("#cms-tags-suggest").getByRole("button", { name: "Use \u201cquotes\u201d" });
      await expect(offer).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(offer).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(tags).toHaveValue("quotes, ");
      expect(await savedTags(page)).toEqual(["quotes"]);
    });

    test("Tab from `quo` reaches the `quotes` suggestion and Enter applies it (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes", "release"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quo");
      const offer = page.locator("#cms-tags-suggest").getByRole("button", { name: "quotes", exact: true });
      await expect(offer).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(offer).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(tags).toHaveValue("quotes, ");
      expect(await savedTags(page)).toEqual(["quotes"]);
    });

    // #756: Decap trims the box on every keystroke, so a space typed after a
    // letter used to vanish and `Field Notes` became `FieldNotes`.
    test("a space typed inside a tag stays: `Field Notes` saves as one tag with its space (#756)", async ({ page }) => {
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("agents, field");
      await page.keyboard.press("Space");
      await expect(tags).toHaveValue("agents, field ");
      await tags.pressSequentially("notes");
      await expect(tags).toHaveValue("agents, field notes");
      expect(await savedTags(page)).toEqual(["agents", "field notes"]);
    });

    test("deleting the first letter of a word keeps the space before it (#756)", async ({ page }) => {
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("Field N");
      await page.keyboard.press("Backspace");
      await expect(tags).toHaveValue("Field ");
      await tags.pressSequentially("Notes");
      expect(await savedTags(page)).toEqual(["Field Notes"]);
    });

    test("a second space, or one right after a comma, is still dropped (#756)", async ({ page }) => {
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("a");
      await page.keyboard.press("Space");
      await page.keyboard.press("Space");
      await expect(tags).toHaveValue("a ");
      await tags.pressSequentially("b, ");
      await expect(tags).toHaveValue("a b, ");
      expect(await savedTags(page)).toEqual(["a b"]);
    });

    // #762: holding the space must hide the keystroke from Decap's React root
    // only. The other admin shims (live-url-banner.js, autosave-on-hide.js)
    // listen for `input` on the same `document`, in the capture phase, and the
    // shim used to cut them off too. This listener is registered AFTER the
    // page's own, so it is exactly the position those shims are in.
    test("a held trailing space still reaches a later input listener on the same document (#762)", async ({ page }) => {
      await openNewPost(page);
      await page.evaluate(() => {
        window.__laterTagsInputs = [];
        document.addEventListener(
          "input",
          (e) => {
            if (e.target && /^tags-field-\d+$/.test(String(e.target.id))) window.__laterTagsInputs.push(e.target.value);
          },
          true,
        );
      });
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("field");
      await page.keyboard.press("Space");
      // The space is held: Decap never trimmed it...
      await expect(tags).toHaveValue("field ");
      // ...and the later listener still saw that very keystroke.
      expect(await page.evaluate(() => window.__laterTagsInputs)).toEqual(["f", "fi", "fie", "fiel", "field", "field "]);
      await tags.pressSequentially("notes");
      expect(await savedTags(page)).toEqual(["field notes"]);
    });

    test("`Field Notes` is compared with the existing `field-notes`, spaces and all (#756)", async ({ page }) => {
      await mockTagsIndex(page, ["field-notes"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("Field");
      await page.keyboard.press("Space");
      await tags.pressSequentially("Notes");
      await expect(page.locator("#cms-tags-suggest")).toContainText(
        "\u201cField Notes\u201d is a new tag that is nearly identical to the existing tag \u201cfield-notes\u201d",
      );
    });

    // #756: an applied suggestion ends the tag, so the next one is not glued on.
    test("after applying a suggestion the next tag is typed after `, ` (#756)", async ({ page }) => {
      await mockTagsIndex(page, ["release-notes", "agents"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("rel");
      const offer = page.locator("#cms-tags-suggest").getByRole("button", { name: "release-notes", exact: true });
      await expect(offer).toBeVisible();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expect(tags).toBeFocused();
      await expect(tags).toHaveValue("release-notes, ");
      await tags.pressSequentially("agent");
      await expect(tags).toHaveValue("release-notes, agent");
      expect(await savedTags(page)).toEqual(["release-notes", "agent"]);
    });

    test("saving right after applying a suggestion saves no empty tag (#756)", async ({ page }) => {
      await mockTagsIndex(page, ["release-notes"]);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("rel");
      await page.locator("#cms-tags-suggest").getByRole("button", { name: "release-notes", exact: true }).click();
      await expect(tags).toHaveValue("release-notes, ");
      expect(await savedTags(page)).toEqual(["release-notes"]);
    });

    // A tag name comes from fetched HTML: it must reach the page as text, never markup.
    test("markup in an existing tag's name is shown as text and injects no element (#735)", async ({ page }) => {
      const evil = "<img src=x onerror=window.__tagsXss=1>";
      await page.route("**/tags/", (route) =>
        route.fulfill({
          contentType: "text/html",
          body:
            "<ul><li><span class='tag-list-name'>quotes</span></li>" +
            "<li><span class='tag-list-name'>" + evil.replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</span></li></ul>",
        }),
      );
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("<img");
      const panel = page.locator("#cms-tags-suggest");
      await expect(panel.getByRole("button", { name: evil, exact: true })).toBeVisible();
      expect(await panel.locator("img").count()).toBe(0);
      expect(await page.locator("img[onerror]").count()).toBe(0);
      expect(await page.evaluate(() => window.__tagsXss)).toBeUndefined();
    });

    // A live region announces what is added to it, so it must exist EMPTY first
    // and be filled in a later task, or the first announcement is skipped.
    test("the status line is created empty and filled a frame later (#735)", async ({ page }) => {
      await mockTagsIndex(page, ["quotes"]);
      await openNewPost(page);
      await page.evaluate(() => {
        window.__panelAtInsert = null;
        new MutationObserver((records) => {
          for (const r of records) {
            for (const n of r.addedNodes) {
              if (n.id === "cms-tags-suggest" && window.__panelAtInsert === null) window.__panelAtInsert = n.childNodes.length;
            }
          }
        }).observe(document.body, { childList: true, subtree: true });
      });
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quote");
      await expect(page.locator("#cms-tags-suggest")).toContainText("\u201cquotes\u201d");
      expect(await page.evaluate(() => window.__panelAtInsert)).toBe(0);
      await expect(page.locator("#cms-tags-suggest")).toHaveAttribute("aria-live", "polite");
    });

    test("a site with no tags index gets no panel and the box works as before (#735)", async ({ page }) => {
      await mockTagsIndex(page, null);
      await openNewPost(page);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("alpha, beta");
      await expect(page.locator("#cms-tags-suggest")).toHaveCount(0);
      expect(await savedTags(page)).toEqual(["alpha", "beta"]);
    });
  },
);

// #756: the chips were ~62x20 px, a fiddly target for a finger. A touch device
// reports `(pointer: coarse)`; give it a 44 px minimum.
test.describe(
  "CMS Tags box suggestion chips are finger-sized on a phone (#756)",
  { tag: ["@admin-write"] },
  () => {
    test.describe.configure({ timeout: 180_000 });
    test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
    test.beforeEach(() => {
      pageErrors = [];
    });

    test("suggestion and warning chips are at least 44 px tall and wide under a coarse pointer", async ({ page }) => {
      await mockTagsIndex(page, ["quotes", "quoted-words"]);
      await openNewPost(page);
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
      const tags = page.getByLabel(/^Tags/);
      await tags.click();
      await tags.pressSequentially("quote");
      const panel = page.locator("#cms-tags-suggest");
      for (const chip of [panel.getByRole("button", { name: "quoted-words", exact: true }), panel.getByRole("button", { name: "Use \u201cquotes\u201d" })]) {
        await expect(chip).toBeVisible();
        const box = await chip.boundingBox();
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
      }
    });
  },
);
