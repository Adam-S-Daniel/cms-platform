// @lane: local — static fixture around the theme's own main.css; no network, no writes, no build
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
// The fixture is a page carrying the theme's real main.css and the card markup
// adamdaniel.ai renders, injected with setContent, so it needs no Jekyll build.
// Two shapes exist there: tools/index.html puts the h3 first in
// .project-card-inner; index.html and projects/index.html put .project-tech
// BEFORE the h3. Both are covered. It is a .test.js on chromium-light so the
// self-CI node-unit-lints lane (`./*.test.js`, --project=chromium-light) runs
// it; it reads theme/ SOURCE, hence the entry in PLATFORM_META_SPECS.

const THEME = path.resolve(__dirname, "..", "theme");
const MAIN_CSS = fs.readFileSync(path.join(THEME, "assets", "css", "main.css"), "utf8");
const PROJECT_LAYOUT = fs.readFileSync(path.join(THEME, "_layouts", "project.html"), "utf8");
const PREVIEW_LAYOUT = fs.readFileSync(path.join(THEME, "_layouts", "preview.html"), "utf8");

// Static animations would repaint body's background mid-measurement.
const FREEZE = "*, *::before, *::after { animation: none !important; transition: none !important; }";

function card({ title, featured, tech, techFirst }) {
  const techLine = tech ? `<p class="project-tech">${tech}</p>` : "";
  return `
    <article class="project-card">
      ${featured ? '<span class="featured-badge">Featured</span>' : ""}
      <div class="project-card-inner">
        ${techFirst ? techLine : ""}
        <h3><a href="/tools/x/">${title}</a></h3>
        ${techFirst ? "" : techLine}
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

const SCOPE = "chromium-light";

const LONG_TITLE = "A Considerably Longer Featured Tool Title For Narrow Cards";
const LONG_WORD = "Supercalifragilisticexpialidocious".repeat(2);

// Each case is one card; `of` is the element whose text must stay clear of the
// badge ("title" is the h3's link, "tech" the .project-tech line).
const OVERLAP_CASES = [
  { name: "title first", card: { title: "Claude Memory Map" }, of: "title" },
  { name: "title first, long title", card: { title: LONG_TITLE }, of: "title" },
  { name: "title first, unbreakable word", card: { title: LONG_WORD }, of: "title" },
  { name: "tech first, short title", card: { title: "Claude Memory Map", tech: "Ruby", techFirst: true }, of: "title" },
  {
    name: "tech first, long technology line",
    card: { title: "Claude Memory Map", tech: "Ruby Rust Java Perl Lisp Dart Zig Lua Go C", techFirst: true },
    of: "tech",
  },
  {
    name: "tech first, unbreakable technology word",
    card: { title: "Claude Memory Map", tech: LONG_WORD, techFirst: true },
    of: "tech",
  },
];
const SELECTOR = { title: ".project-card h3 a", tech: ".project-card .project-tech" };

// The Featured pill each layout carries inline. DOMParser (no scripts run)
// lifts the real element, so the layout file's own inline style is measured.
async function pillMarkup(page, layoutHtml) {
  return page.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const pills = doc.querySelectorAll('span.tag-pill[style*="--accent"]');
    if (pills.length !== 1) throw new Error(`expected one Featured pill, found ${pills.length}`);
    pills[0].removeAttribute("hidden");
    return pills[0].outerHTML;
  }, layoutHtml);
}

test.describe("theme: FEATURED badge and small accent text", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== SCOPE, "Sets its own viewport; one project is enough");
  });

  for (const width of [320, 390]) {
    for (const c of OVERLAP_CASES) {
      test(`${width}px, ${c.name}: the text wraps clear of the badge`, async ({ page }) => {
        await page.setViewportSize({ width, height: 640 });
        await page.setContent(fixture(card({ ...c.card, featured: true })));
        const { badge, rects, overflow } = await page.evaluate((sel) => {
          const b = document.querySelector(".featured-badge").getBoundingClientRect();
          const el = document.querySelector(sel);
          const range = document.createRange();
          range.selectNodeContents(el);
          const card = document.querySelector(".project-card").getBoundingClientRect();
          return {
            badge: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
            rects: Array.from(range.getClientRects()).map((r) => ({
              left: r.left,
              right: r.right,
              top: r.top,
              bottom: r.bottom,
            })),
            overflow: Math.max(0, ...Array.from(range.getClientRects()).map((r) => r.right - card.right)),
          };
        }, SELECTOR[c.of]);
        expect(rects.length, "there are text boxes to measure").toBeGreaterThan(0);
        for (const r of rects) {
          const overlaps =
            r.left < badge.right && r.right > badge.left && r.top < badge.bottom && r.bottom > badge.top;
          expect(overlaps, `text box ${JSON.stringify(r)} runs under badge ${JSON.stringify(badge)}`).toBe(false);
        }
        expect(overflow, "text must not spill past the card's right edge").toBe(0);
      });
    }
  }

  test("a card with no badge keeps the full title width", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.setContent(
      fixture(card({ title: "Plain", featured: false }) + card({ title: "Plain", featured: false, tech: "Ruby", techFirst: true })),
    );
    const pads = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".project-card-inner > h3, .project-card-inner > .project-tech")).map((e) => getComputedStyle(e).paddingRight),
    );
    expect(pads.every((p) => p === "0px"), JSON.stringify(pads)).toBe(true);
  });

  test("small accent text is at least 4.5:1 on --bg-0, --bg-1 and --bg-2", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    const projectPill = await pillMarkup(page, PROJECT_LAYOUT);
    const previewPill = await pillMarkup(page, PREVIEW_LAYOUT);
    await page.setContent(
      fixture(
        card({ title: "Claude Memory Map", featured: true, tech: "Python" }),
        `<div id="project-layout">${projectPill}</div><div id="preview-layout">${previewPill}</div>`,
      ),
    );
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
          "project.html Featured pill": color("#project-layout .tag-pill"),
          "preview.html Featured pill": color("#preview-layout .tag-pill"),
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
