// ESLint config for ONE check: no HTML sink (innerHTML, outerHTML,
// insertAdjacentHTML, document.write, ...) receives a value that has not
// passed through a declared escaper (cms-platform#982). It is not a style
// lint and turns on no other rule.
//
// Run from the repo root:
//   e2e/node_modules/.bin/eslint -c e2e/eslint.html-sinks.config.mjs <files>
// scripts/lint-staged.sh runs it on staged files at commit time, and
// e2e/html-sink-lint.test.js runs it on the whole tree in the required
// node-unit-lints lane.
//
// An escaper is a function that HTML-encodes its argument for the context it
// lands in. Add a name here only after reading its body. A sink that is safe
// for another reason (a value built only from literals and escaped parts the
// plugin cannot follow) takes an inline disable WITH a reason:
//   // eslint-disable-next-line no-unsanitized/property -- <why it is safe>
// The test fails on a disable without one.
import html from "eslint-plugin-html";
import nounsanitized from "eslint-plugin-no-unsanitized";

// Every helper in this repo that HTML-encodes its argument.
export const ESCAPERS = ["escapeHTML", "escapeHtml", "esc"];

const escape = { methods: ESCAPERS };

// Code that runs in a browser: the admin UI and the theme's layouts,
// includes and assets (inline <script>s too, via eslint-plugin-html), plus the
// scaffolder's seeds. Node-only scripts have no DOM, and test files build DOM
// fixtures out of literals and are served to no one.
export const FILES = [
  "theme/**/*.js",
  "theme/**/*.html",
  "scaffold/**/*.js",
];

export default [
  {
    files: FILES,
    plugins: { html, "no-unsanitized": nounsanitized },
    languageOptions: { ecmaVersion: "latest", sourceType: "script" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "no-unsanitized/method": ["error", { escape }],
      "no-unsanitized/property": ["error", { escape }],
    },
  },
  {
    ignores: ["**/node_modules/**", "**/vendor/**", "**/_site/**"],
  },
];
