// @lane: local — reads the site's source tree for the pages to open; @parity-eligible via TARGET=
const { test, expect } = require("./base");
const { isAllowlisted } = require("./console-allowlist");
const { targetsFromEnv } = require("./page-frame-targets");

// Page frame intact (cms-platform#1070) — @parity
// ─────────────────────────────────────────────────────────────────────────────
// A post's own HTML, CSS or script can break the page AROUND it: a `<style>`
// hiding the header, a pasted `position: fixed` banner covering the menu, a
// `<base href>` sending every menu link to another site, an over-wide element
// making the page scroll sideways. HTML embeds are a feature, so no rule about
// tags can stop these without rejecting real posts (issue 1067 measured all
// four publishing green). This spec looks at the result instead.
//
// DESIGN RULE (as for the site verifier): it may fail only on a page that is
// broken, never on an authoring choice. It asserts nothing about what a post
// says or looks like, only that the frame around it still works.
//
// Where it runs:
//   - before publish, blocking: parity-preview.yml, TARGET=preview, on the
//     posts the pull request changed (PAGE_FRAME_CHANGED);
//   - after publish, alerting: page-frame-live.yml, TARGET=prod, on the posts
//     the push changed, and daily on every post (PAGE_FRAME_ALL=1). Its
//     failures open an issue per page and prepare an unpublish pull request
//     (scripts/page-frame-alert.js), and cross-posting waits for it;
//   - in the local e2e lanes, on the built site.
//
// Viewports are set per page (390 and 1280 wide), so one project is enough:
// the other public projects skip it rather than repeat the same checks.
const FRAME_PROJECT = "chromium-desktop-1080";
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

const TARGETS = targetsFromEnv();
// The production origin to compare listings against (preview lane only).
const REFERENCE_URL = (process.env.PAGE_FRAME_REFERENCE_URL || "").replace(/\/+$/, "");

// Runs in the page. Returns a list of plain-language problems; empty is intact.
function inspectFrame({ isPost }) {
  const problems = [];
  const describe = (el) => {
    if (!el) return "nothing";
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).join(".")}`
      : "";
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  };
  const rendered = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  // The element at the control's own center point is the control (or inside
  // it). Anything else on top means a reader cannot click it.
  const uncovered = (el, name) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
      problems.push(`${name} is outside the visible window`);
      return;
    }
    const hit = document.elementFromPoint(x, y);
    if (!hit || !(hit === el || el.contains(hit))) {
      problems.push(`${name} is covered by ${describe(hit)}`);
    }
  };

  const header = document.querySelector(".site-header");
  const footer = document.querySelector(".site-footer");
  if (!rendered(header)) problems.push("the site header is not rendered");
  if (!rendered(footer)) problems.push("the site footer is not rendered");
  const firstLink = header && header.querySelector("a[href]");
  if (header && !firstLink) problems.push("the site header has no link");
  if (rendered(header) && firstLink) {
    window.scrollTo(0, 0);
    uncovered(firstLink, "the header's first link");
  }
  if (header) {
    for (const a of header.querySelectorAll("a[href]")) {
      let origin = null;
      try {
        origin = new URL(a.href).origin;
      } catch {
        // an unparseable href is reported below as off-site
      }
      if (origin !== location.origin) {
        problems.push(`the header link "${a.textContent.trim()}" points at ${a.href}, not this site`);
      }
    }
  }

  if (isPost) {
    const share = document.querySelector(".share-row");
    if (!share) {
      problems.push("the share row is missing");
    } else if (!share.closest("article")) {
      problems.push("the share row is outside the article");
    } else {
      const control = share.querySelector(".share-link");
      if (!rendered(control)) {
        problems.push("the share row's first control is not rendered");
      } else {
        control.scrollIntoView({ block: "center", inline: "center" });
        uncovered(control, "the share row's first control");
      }
    }
  }

  const doc = document.documentElement;
  if (doc.scrollWidth > doc.clientWidth + 1) {
    problems.push(`the page scrolls sideways (${doc.scrollWidth}px wide in a ${doc.clientWidth}px window)`);
  }
  return problems;
}

function countRows(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelectorAll(".post-list .post-item").length;
}

function hiddenRows() {
  return Array.from(document.querySelectorAll(".post-list .post-item")).filter((li) => {
    const r = li.getBoundingClientRect();
    return !(r.width > 0 && r.height > 0) || getComputedStyle(li).visibility === "hidden";
  }).length;
}

// Open one page at both widths and collect every problem, so a failure names
// all of them at once instead of the first.
async function checkPage(page, urlPath, { isPost = false, listing = false } = {}) {
  const problems = [];
  const errors = [];
  const onConsole = (msg) => {
    if (msg.type() === "error" && !isAllowlisted(msg.text())) errors.push(`console.error: ${msg.text()}`);
  };
  const onPageError = (err) => {
    const text = `${err.name}: ${err.message}`;
    if (!isAllowlisted(text)) errors.push(`pageerror: ${text}`);
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  let tagLinks = [];
  try {
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      const response = await page.goto(urlPath, { waitUntil: "load" });
      const status = response ? response.status() : 0;
      if (status !== 200) {
        problems.push(`${urlPath} at ${vp.width}px answered ${status || "nothing"}`);
        continue;
      }
      for (const p of await page.evaluate(inspectFrame, { isPost })) {
        problems.push(`${urlPath} at ${vp.width}px: ${p}`);
      }
      if (listing) {
        const hidden = await page.evaluate(hiddenRows);
        if (hidden > 0) problems.push(`${urlPath} at ${vp.width}px: ${hidden} post row(s) are not rendered`);
      }
      if (isPost && tagLinks.length === 0) {
        tagLinks = await page.evaluate(() =>
          Array.from(document.querySelectorAll("article a[href]"))
            .map((a) => new URL(a.href, location.href))
            .filter((u) => u.origin === location.origin && /^\/tags\/[^/]+\/$/.test(u.pathname))
            .map((u) => u.pathname),
        );
      }
    }
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
  for (const e of new Set(errors)) problems.push(`${urlPath}: ${e}`);
  return { problems, tagLinks: Array.from(new Set(tagLinks)) };
}

// A listing shows at least as many rows as production does, less the posts
// this change removes. Preview lane only: after publish, production IS the
// page being checked.
async function listingRowProblems(page, urlPath) {
  if (!REFERENCE_URL) return [];
  const here = await page.request.get(urlPath);
  const there = await page.request.get(`${REFERENCE_URL}${urlPath}`);
  if (!here.ok() || !there.ok()) return [];
  const [mine, theirs] = await Promise.all([
    page.evaluate(countRows, await here.text()),
    page.evaluate(countRows, await there.text()),
  ]);
  const floor = theirs - TARGETS.removedPosts;
  return mine < floor
    ? [`${urlPath} lists ${mine} post(s); production lists ${theirs}, and this change removes ${TARGETS.removedPosts}`]
    : [];
}

test.describe("Page frame intact @parity", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== FRAME_PROJECT, `Sets its own viewports; runs once, on ${FRAME_PROJECT}.`);
  });

  if (TARGETS.listings.length === 0 && TARGETS.posts.length === 0) {
    test("no theme-rendered page to check on this site", () => {
      test.skip(true, "The home page uses a site-owned layout and the site keeps no posts collection.");
    });
  }

  for (const urlPath of TARGETS.listings) {
    test(`@parity frame intact on ${urlPath}`, async ({ page }, testInfo) => {
      testInfo.annotations.push({ type: "page", description: urlPath });
      const { problems } = await checkPage(page, urlPath, { listing: true });
      problems.push(...(await listingRowProblems(page, urlPath)));
      expect(problems, `The page frame is broken:\n  ${problems.join("\n  ")}`).toEqual([]);
    });
  }

  for (const post of TARGETS.posts) {
    test(`@parity frame intact on ${post.path} and its tag pages`, async ({ page }, testInfo) => {
      testInfo.annotations.push({ type: "page", description: post.path });
      testInfo.annotations.push({ type: "source", description: post.source });
      const { problems, tagLinks } = await checkPage(page, post.path, { isPost: true });
      for (const tagPath of tagLinks) {
        const tag = await checkPage(page, tagPath, { listing: true });
        problems.push(...tag.problems);
      }
      expect(problems, `The page frame is broken:\n  ${problems.join("\n  ")}`).toEqual([]);
    });
  }
});
