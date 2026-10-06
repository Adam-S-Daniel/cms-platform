// @lane: local — injects a static fixture into a locally-served page; no network, no writes
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const cap = require("./site-capabilities");

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

// #729 — a bare Markdown table also needs to be READABLE: cell padding, borders
// in the theme's border color, a header row, and room below it. A classed table
// (adamdaniel.ai's .bws-table) styles its own cells and must be left alone, as
// must the horizontal-scroll box #540 gave the bare one.
test.describe("bare Markdown table styling (#729)", () => {
  for (const vp of [VIEWPORTS[1], VIEWPORTS[3]]) {
    test(`${vp.name}: cells are padded and bordered, the header is distinct, classed tables are untouched`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "chromium-mobile",
        "Sets its own viewport; one project is enough",
      );
      // The cell rules live in the theme's main.css, linked by its default.html.
      // A home page on a site-owned layout (jodidaniel.com's _layouts/home.html
      // loads only its own stylesheet, which copies the #540 scroll rule and
      // nothing else) never asked for them; the #540 test above still covers it.
      // Decided from the site's source inside the test, like reduced-motion.spec.js.
      test.skip(
        !cap.homeUsesThemeLayout(),
        "the home page renders through a site-owned layout that does not load the theme's main.css",
      );
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.evaluate(() => {
        const host = document.querySelector("main") || document.body;
        const wrap = document.createElement("div");
        wrap.className = "container";
        const body = document.createElement("div");
        body.className = "page-content";
        body.innerHTML = `
          <table id="md-table"><thead><tr><th>Mode</th><th>Latency</th></tr></thead>
            <tbody><tr><td>fast</td><td style="text-align: right">1,450 ms</td></tr></tbody></table>
          <p id="md-after">After the table.</p>
          <table id="classed-table" class="bws-table"><tbody><tr><td>cell</td></tr></tbody></table>`;
        wrap.appendChild(body);
        host.appendChild(wrap);
      });

      const px = (v) => Number.parseFloat(v);
      const cell = await page.locator("#md-table td").first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          padLeft: cs.paddingLeft, padTop: cs.paddingTop,
          borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle, borderColor: cs.borderTopColor,
        };
      });
      expect(px(cell.padLeft), "td horizontal padding").toBeGreaterThanOrEqual(8);
      expect(px(cell.padTop), "td vertical padding").toBeGreaterThanOrEqual(4);
      expect(cell.borderStyle).toBe("solid");
      expect(px(cell.borderWidth)).toBeGreaterThanOrEqual(1);
      expect(cell.borderColor, "border is the theme's --border token").toBe(
        await page.evaluate(() => {
          const probe = document.createElement("i");
          probe.style.color = "var(--border)";
          document.body.appendChild(probe);
          const c = getComputedStyle(probe).color;
          probe.remove();
          return c;
        }),
      );

      // Header: heavier than a body cell, with its own background.
      const head = await page.locator("#md-table th").first().evaluate((el) => {
        const cs = getComputedStyle(el);
        return { weight: Number(cs.fontWeight), bg: cs.backgroundColor };
      });
      const bodyWeight = await page.locator("#md-table td").first().evaluate((el) => Number(getComputedStyle(el).fontWeight));
      expect(head.weight).toBeGreaterThan(bodyWeight);
      expect(head.bg).not.toBe("rgba(0, 0, 0, 0)");

      // A Markdown alignment (inline style) still wins over the left default.
      await expect(page.locator("#md-table td").nth(1)).toHaveCSS("text-align", "right");

      // Room below the table: the next paragraph does not butt against it.
      const table = await page.locator("#md-table").boundingBox();
      const after = await page.locator("#md-after").boundingBox();
      expect(after.y - (table.y + table.height), "gap between table and next paragraph").toBeGreaterThanOrEqual(16);

      // Still its own horizontal scroll box (#540).
      await expect(page.locator("#md-table")).toHaveCSS("overflow-x", "auto");

      // A classed table keeps the browser defaults: no theme padding or border.
      const classed = await page.locator("#classed-table td").evaluate((el) => {
        const cs = getComputedStyle(el);
        return { padLeft: cs.paddingLeft, borderWidth: cs.borderTopWidth };
      });
      expect(px(classed.padLeft)).toBeLessThan(4);
      expect(px(classed.borderWidth)).toBe(0);
    });
  }
});
