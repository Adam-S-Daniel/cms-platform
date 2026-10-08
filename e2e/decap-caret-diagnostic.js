const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

const ADMIN = path.resolve(__dirname, "../theme/admin");
const BUNDLE_CACHE = path.resolve(__dirname, "node_modules/.cache/decap-caret/decap-cms.js");
const PARAGRAPHS = [
  "Alpha paragraph has several words.",
  "Bravo paragraph also has several words.",
];

async function readShell() {
  const { parse } = await import("parse5");
  const scripts = [];
  function visit(node) {
    if (node.tagName === "script") {
      const attrs = Object.fromEntries(node.attrs.map(({ name, value }) => [name, value]));
      if (attrs.src) scripts.push(attrs);
    }
    for (const child of node.childNodes || []) visit(child);
  }
  visit(parse(fs.readFileSync(path.join(ADMIN, "index-local.html"), "utf8")));
  const pins = scripts.filter(({ src }) => src.startsWith("https://unpkg.com/decap-cms@"));
  if (pins.length !== 1 || !/^https:\/\/unpkg\.com\/decap-cms@\d+\.\d+\.\d+\/dist\/decap-cms\.js$/.test(pins[0].src)) {
    throw new Error("Expected one exact stock Decap bundle pin in index-local.html");
  }
  for (const script of scripts) {
    if (script !== pins[0] && !/^[a-z0-9-]+\.js$/.test(script.src)) {
      throw new Error("Unexpected script path in diagnostic shell");
    }
  }
  return { scripts, pin: pins[0] };
}

function verifyBundle(bundle, integrity) {
  const actual = `sha384-${createHash("sha384").update(bundle).digest("base64")}`;
  if (actual !== integrity) throw new Error("Diagnostic Decap bundle does not match the shell SRI");
  return bundle;
}

async function openDiagnostic(page, { platform, raw, hidden, bundlePath }) {
  const { scripts, pin } = await readShell();
  const bundle = verifyBundle(fs.readFileSync(bundlePath), pin.integrity);
  const selected = platform ? scripts : [pin];
  const markup = '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    selected.map(({ src, defer }) => `<script src="${src}"${defer !== undefined ? " defer" : ""}></script>`).join("") +
    '<script>CMS.init({config:window.caretConfig});</script></body></html>';
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.href === pin.src) return route.fulfill({ body: bundle, contentType: "application/javascript" });
    if (url.origin === "http://localhost:4355" && url.pathname === "/admin/caret.html") {
      return route.fulfill({ body: markup, contentType: "text/html" });
    }
    const script = selected.find(({ src }) => url.pathname === `/admin/${src}`);
    if (script) return route.fulfill({ path: path.join(ADMIN, script.src), contentType: "application/javascript" });
    return route.fulfill({ status: 404, body: "" });
  });
  await page.addInitScript((paragraphs) => {
    window.CMS_MANUAL_INIT = true;
    window.repoFiles = {
      posts: { "caret.md": { content: `---\ntitle: Neutral caret probe\n---\n${paragraphs.join("\n\n")}\n` } },
    };
    window.repoFilesUnpublished = [];
    window.caretConfig = {
      backend: { name: "test-repo" },
      media_folder: "media",
      collections: [{ name: "posts", label: "Posts", folder: "posts", create: true, fields: [
        { name: "title", label: "Title", widget: "string" },
        { name: "body", label: "Body", widget: "markdown" },
      ] }],
    };
  }, PARAGRAPHS);
  await page.goto("http://localhost:4355/admin/caret.html");
  await page.getByRole("button", { name: /login/i }).click();
  await page.evaluate(() => { location.hash = "#/collections/posts/entries/caret"; });
  await page.locator('[contenteditable="true"]').waitFor();
  if (raw) await page.getByRole("switch").click();
  if (hidden) await page.locator('[title="Toggle preview"]').click();
  const editor = page.locator('[contenteditable="true"]');
  await editor.waitFor();
  await editor.evaluate((element) => {
    // Read-only inspection of the actual Slate instance. This lets the
    // reduction establish a settled initial caret without a timer or changing
    // editor.selection. Failure to find it fails setup, not the defect oracle.
    let fiber = element[Object.keys(element).find((key) => key.startsWith("__reactFiber"))];
    while (fiber) {
      if (fiber.memoizedProps?.editor) {
        window.caretSlate = fiber.memoizedProps.editor;
        break;
      }
      fiber = fiber.return;
    }
    window.caretEvents = [];
    for (const type of ["mousedown", "mouseup", "click", "selectionchange", "keydown", "beforeinput", "input"]) {
      document.addEventListener(type, (event) => {
        const selection = window.getSelection();
        window.caretEvents.push({
          type, key: event.key, data: event.data,
          anchor: selection.anchorNode?.textContent,
          offset: selection.anchorOffset,
          text: element.innerText,
          slateSelection: window.caretSlate?.selection ? JSON.parse(JSON.stringify(window.caretSlate.selection)) : null,
          targetRanges: typeof event.getTargetRanges === "function" ? [...event.getTargetRanges()].map((range) => ({
            start: range.startContainer.textContent, startOffset: range.startOffset,
            end: range.endContainer.textContent, endOffset: range.endOffset,
          })) : undefined,
        });
      }, true);
    }
  });
  return { editor, errors, scriptCount: selected.length, pin };
}

async function caretPoint(editor, paragraph, offset) {
  return editor.locator('[data-slate-string="true"]').nth(paragraph).evaluate((element, position) => {
    const range = document.createRange();
    range.setStart(element.firstChild, position);
    range.setEnd(element.firstChild, position + 1);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + 1, y: rect.y + rect.height / 2 };
  }, offset);
}

module.exports = { BUNDLE_CACHE, PARAGRAPHS, readShell, verifyBundle, openDiagnostic, caretPoint };
