// @lane: local — pure-fs lint; parses deploy-preview.yml with the real `yaml`
// package and reads the page's custom-property palette (lexical tokens only).
//
// cms-platform#651 — the preview 404 page (the heredoc in the "Ensure preview
// 404 error page exists at bucket root" step) rendered light grey text on a
// white card in a dark color scheme: the dark `.card` background sat BEFORE
// the base `.card` rule and lost the cascade. The page now keeps its palette
// in custom properties, one set per scheme, so that cannot recur. This lint
// holds every text/background pair to WCAG AA (4.5:1) in BOTH schemes and
// rejects a literal color in a rule (which would bypass the palette).
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("./base");
const { parseYaml } = require("./workflow-yaml-utils");

const WORKFLOW = path.join(__dirname, "..", ".github", "workflows", "deploy-preview.yml");
const STEP_NAME = "Ensure preview 404 error page exists at bucket root";

function pageHtml() {
  const wf = parseYaml(fs.readFileSync(WORKFLOW, "utf8"));
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps || []);
  const step = steps.find((s) => s.name === STEP_NAME);
  expect(step, `step "${STEP_NAME}" exists`).toBeTruthy();
  const m = /<<'HTML'\n([\s\S]*?)\n\s*HTML\n/.exec(step.run);
  expect(m, "heredoc found").toBeTruthy();
  return m[1];
}

function styleText(html) {
  const m = /<style>([\s\S]*?)<\/style>/.exec(html);
  expect(m, "<style> found").toBeTruthy();
  return m[1].replace(/\/\*[\s\S]*?\*\//g, "");
}

// Custom properties declared in the first `:root {...}` block, and in the
// `:root {...}` block nested in the prefers-color-scheme: dark media query.
function palettes(css) {
  const props = (body) => {
    const out = {};
    for (const [, k, v] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
    return out;
  };
  const dark = /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css);
  expect(dark, "dark-scheme :root block").toBeTruthy();
  const light = /:root\s*\{([^}]*)\}/.exec(css.replace(dark[0], ""));
  expect(light, "light :root block").toBeTruthy();
  return { light: props(light[1]), dark: { ...props(light[1]), ...props(dark[1]) } };
}

function luminance(hex) {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Text colors paired with the surface each is drawn on.
const PAIRS = [
  ["text", "card-bg"],
  ["muted", "card-bg"],
  ["link", "card-bg"],
  ["text", "page-bg"],
];

test.describe("preview 404 page contrast (#651)", () => {
  for (const scheme of ["light", "dark"]) {
    for (const [fg, bg] of PAIRS) {
      test(`${scheme}: --${fg} on --${bg} meets WCAG AA 4.5:1`, () => {
        const pal = palettes(styleText(pageHtml()))[scheme];
        expect(pal[fg], `--${fg} defined`).toMatch(/^#[0-9a-f]{3,6}$/i);
        expect(pal[bg], `--${bg} defined`).toMatch(/^#[0-9a-f]{3,6}$/i);
        expect(contrast(pal[fg], pal[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  test("rules take colors from the palette, never a literal", () => {
    const css = styleText(pageHtml());
    const dark = /@media[^{]*\{\s*:root\s*\{[^}]*\}\s*\}/.exec(css)[0];
    const rules = css.replace(dark, "").replace(/:root\s*\{[^}]*\}/, "");
    const literal = [...rules.matchAll(/(?:^|[;{\s])(color|background|border)\s*:\s*([^;}]+)/g)]
      .map((m) => m[2].trim())
      .filter((v) => /#[0-9a-f]{3,6}\b/i.test(v));
    expect(literal).toEqual([]);
  });
});
