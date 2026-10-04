// @lane: local — injects a static fixture into a locally-served page; no network, no writes
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// #540 (8.4) — a wide Markdown table or a fixed-width <iframe> must not make
// the PAGE scroll sideways on a phone, and the table's content must stay
// reachable (it scrolls inside its own box).
//
// The fixture is a fragment (a bare, class-less <table> — exactly what
// kramdown emits for a Markdown table — and an <iframe width="800"> with an
// inline `srcdoc`, so nothing remote loads). It is injected into the SITE'S
// OWN home page rather than shipped as a page of `e2e/fixture-site`, because
// this spec runs on every consumer (adamdaniel.ai, jodidaniel.com) and
// content never syncs: the consumer asserts against ITS layout and the
// stylesheet it actually serves, and no consumer needs a fixture page.
//
// The viewport is set explicitly (like cms-mobile-layout.spec.js) so one
// project covers phone / tablet / desktop; chromium-mobile is the project
// that carries it, the others would repeat the identical pass.

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "responsive-overflow.html"), "utf8");

const VIEWPORTS = [
  { name: "phone 360", width: 360, height: 740 },
  { name: "phone 390", width: 390, height: 844 },
  { name: "tablet 768", width: 768, height: 1024 },
  { name: "desktop 1280", width: 1280, height: 800 },
];

test.describe("responsive tables and iframes (#540)", () => {
  for (const vp of VIEWPORTS) {
    test(`${vp.name}: page does not scroll sideways; table and iframe stay inside it`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "Sets its own viewport; one project is enough",
      );
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");

      // Same wrapper a page layout gives its content, appended to <main>.
      await page.evaluate((html) => {
        const host = document.querySelector("main") || document.body;
        const wrap = document.createElement("div");
        wrap.className = "container";
        const body = document.createElement("div");
        body.className = "page-content";
        body.innerHTML = html;
        wrap.appendChild(body);
        host.appendChild(wrap);
      }, FIXTURE);

      const table = page.locator(".page-content table");
      const iframe = page.locator("#responsive-overflow-iframe");
      await expect(table).toBeVisible();
      await expect(iframe).toBeVisible();

      // 1. The document itself does not overflow.
      const doc = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        doc.scrollWidth,
        `Document scrolls horizontally at ${vp.width}px (scrollWidth ${doc.scrollWidth} > clientWidth ${doc.clientWidth})`,
      ).toBeLessThanOrEqual(doc.clientWidth);

      // 2. The table is its own scroll box, and its far end is reachable.
      const box = await table.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
      }));
      expect(box.overflowX).toBe("auto");
      expect(box.scrollWidth, "fixture table must be wider than its box").toBeGreaterThan(
        box.clientWidth,
      );
      await table.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      const lastCell = await page.locator("#responsive-overflow-last-cell").boundingBox();
      expect(lastCell.x + lastCell.width, "last table cell can be scrolled into view").toBeLessThanOrEqual(
        vp.width,
      );

      // 3. The iframe shrinks to its container but keeps a usable height.
      const frame = await iframe.boundingBox();
      expect(frame.x + frame.width, "iframe stays within the viewport").toBeLessThanOrEqual(
        vp.width,
      );
      expect(frame.width).toBeGreaterThan(0);
      expect(frame.height).toBeGreaterThanOrEqual(150);
    });
  }
});
