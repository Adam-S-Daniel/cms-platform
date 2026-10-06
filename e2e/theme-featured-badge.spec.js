// @lane: local — static fixture around the theme's own main.css; no network, no writes
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");

// UX round 4 triage package 3 (vr F1, F2): on a 320px phone the FEATURED
// badge sat on the last letters of "Claude Memory Map" ("Map" struck through),
// and its 12px blue text was 3.7:1 on the card (AA needs 4.5:1).
//
// The badge is position:absolute and a SIBLING of .project-card-inner, so the
// card's h3 reserved nothing for it. The fix pads the h3 (the title wraps) and
// adds an --accent-text token for small accent text, keeping --accent for
// borders.
//
// The fixture is a page carrying the theme's real main.css and the exact card
// markup adamdaniel.ai's tools/index.html renders, injected with setContent,
// so it needs no Jekyll build. It reads theme/ SOURCE, hence the entry in
// playwright.config.js's PLATFORM_META_SPECS.

const THEME = path.resolve(__dirname, "..", "theme");
const MAIN_CSS = fs.readFileSync(path.join(THEME, "assets", "css", "main.css"), "utf8");
const PROJECT_LAYOUT = fs.readFileSync(path.join(THEME, "_layouts", "project.html"), "utf8");

// Static animations would repaint body's background mid-measurement.
const FREEZE = "*, *::before, *::after { animation: none !important; transition: none !important; }";

function card({ title, featured, tech }) {
  return `
    <article class="project-card">
      ${featured ? '<span class="featured-badge">Featured</span>' : ""}
      <div class="project-card-inner">
        <h3><a href="/tools/x/">${title}</a></h3>
        ${tech ? `<p class="project-tech">${tech}</p>` : ""}
        <p class="project-description">A short description of the tool.</p>
        <a class="project-link" href="/tools/x/">Open tool &rarr;</a>
      </div>
    </article>`;
}

function fixture(cards, extra = "") {
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${MAIN_CSS}</style><style>${FREEZE}</style></head>
    <body><div class="container container--wide"><div class="projects-grid">${cards}</div>${extra}</div></body></html>`;
}

// Relative luminance and contrast of two "rgb(r, g, b)" strings.
function contrast(a, b) {
  const lum = (c) => {
    const [r, g, bl] = c
      .match(/\d+/g)
      .slice(0, 3)
      .map((v) => {
        const x = Number(v) / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SCOPE = "chromium-mobile";
const TITLES = ["Claude Memory Map", "A Considerably Longer Featured Tool Title For Narrow Cards"];

test.describe("theme: FEATURED badge and small accent text", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== SCOPE, "Sets its own viewport; one project is enough");
  });

  for (const width of [320, 390]) {
    for (const title of TITLES) {
      test(`${width}px: the title "${title}" wraps clear of the badge`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        await page.setContent(fixture(card({ title, featured: true })));
        const { badge, rects } = await page.evaluate(() => {
          const b = document.querySelector(".featured-badge").getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(".project-card h3 a"));
          return {
            badge: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
            rects: Array.from(range.getClientRects()).map((r) => ({
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            })),
          };
        });
        expect(rects.length, "the title has text boxes to measure").toBeGreaterThan(0);
        for (const r of rects) {
          const overlaps =
            r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top;
          expect(overlaps, `title box ${JSON.stringify(r)} runs under badge ${JSON.stringify(badge)}`).toBe(false);
        }
      });
    }
  }

  test("a card with no badge keeps the full title width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.setContent(fixture(card({ title: "Plain", featured: false })));
    const pad = await page.evaluate(
      () => getComputedStyle(document.querySelector(".project-card h3")).paddingRight,
    );
    expect(pad).toBe("0px");
  });

  test("small accent text is at least 4.5:1 on --bg-0, --bg-1 and --bg-2", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    // The project layout's inline "Featured" pill is part of the page header:
    // load the layout file itself (its Liquid renders as inert text) so the
    // pill's real inline style is what gets measured.
    const html = fixture(
      card({ title: "Claude Memory Map", featured: true, tech: "Python" }),
      `<div id="layout">${PROJECT_LAYOUT}</div>`,
    );
    await page.setContent(html);
    const measured = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const probe = document.createElement("span");
      const bg = {};
      for (const name of ["--bg-0", "--bg-1", "--bg-2"]) {
        probe.style.color = root.getPropertyValue(name).trim();
        document.body.append(probe);
        bg[name] = getComputedStyle(probe).color;
        probe.remove();
      }
      const color = (sel) => getComputedStyle(document.querySelector(sel)).color;
      return {
        bg,
        text: {
          ".featured-badge": color(".featured-badge"),
          ".project-tech": color(".project-card .project-tech"),
          "project layout Featured pill": color("#layout .tag-pill"),
        },
      };
    });
    for (const [label, fg] of Object.entries(measured.text)) {
      for (const [token, bg] of Object.entries(measured.bg)) {
        expect(contrast(fg, bg), `${label} ${fg} on ${token} ${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("the badge keeps --accent for its border", async ({ page }) => {
    await page.setContent(fixture(card({ title: "Claude Memory Map", featured: true })));
    const { border, accent } = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--accent");
      document.body.append(probe);
      const accentRgb = getComputedStyle(probe).color;
      probe.remove();
      return {
        border: getComputedStyle(document.querySelector(".featured-badge")).borderTopColor,
        accent: accentRgb,
      };
    });
    expect(border).toBe(accent);
  });
});
