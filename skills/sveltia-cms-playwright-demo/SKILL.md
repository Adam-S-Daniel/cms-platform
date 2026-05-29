---
name: sveltia-cms-playwright-demo
description: Historical learnings from automating Playwright screenshots of Sveltia CMS with a local-backend mock — scroll containers, body-editor detection, font interception, IndexedDB mocking, and other Sveltia-specific quirks. Reference only; this repo runs Decap CMS now, not Sveltia.
---

# Sveltia CMS Headless Playwright Demo

Learnings from building automated Playwright screenshots of Sveltia CMS running with a local-backend mock.

## Scroll Containers

**Problem:** `window.scrollBy()` and `window.scrollTo()` do NOT scroll the CMS form content — Sveltia CMS uses its own internal scroll container, not the window.

**Fix:** Use `element.scrollIntoView({block: 'center', behavior: 'instant'})` directly on the target element, then re-query the element's position after scrolling.

```python
await page.evaluate("""
(() => {
  function find(root) {
    for (const el of root.querySelectorAll(
      '[contenteditable="true"], [contenteditable=""], .cm-content, .ProseMirror'
    )) {
      if (el.getBoundingClientRect().width > 300) {
        el.scrollIntoView({block: 'center', behavior: 'instant'});
        return true;
      }
    }
    for (const el of root.querySelectorAll('*'))
      if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
    return false;
  }
  return find(document);
})()
""")
await page.wait_for_timeout(400)
# Now re-query position — it will be in viewport
```

## Body Editor Detection

Filter contenteditable elements by `r.width > 300` (not by x-position) to find the main body editor rather than inline title inputs. The body editor is typically off-screen below the fold on initial load.

## Loading Screen Capture

To capture a custom loading overlay before Sveltia JS dismisses it, use `wait_until="commit"`:

```python
await page.goto(ADMIN_URL, wait_until="commit")
await shot(page, "loading_screen")  # before any JS fires
await page.wait_for_load_state("domcontentloaded")
```

`wait_until="domcontentloaded"` is too late — Sveltia's JS has already run and replaced the overlay.

## Sidebar Navigation

`button[role="option"]` sidebar buttons exist in the DOM but have **0×0 bounding boxes** when the editor is open (new/edit post mode) — clicking by coordinates fails silently.

Reliable pattern: visual click first, fall back to hash URL:

```python
_COLLECTION_SLUGS = {"Posts": "posts", "Tags": "tags", "Projects": "projects", "Pages": "pages"}

async def click_sidebar(page, collection, wait=1500):
    clicked = await page.evaluate(f"""
    (() => {{
      for (const b of document.querySelectorAll('button[role="option"]')) {{
        if ((b.innerText || '').includes({json.dumps(collection)})) {{
          const r = b.getBoundingClientRect();
          if (r.width > 0 && r.y >= 0 && r.y < 900) {{
            b.click(); return 'visual';
          }}
        }}
      }}
      return null;
    }})()
    """)
    if not clicked:
        slug = _COLLECTION_SLUGS.get(collection)
        if slug:
            base = page.url.split("#")[0].split("?")[0]
            await page.goto(f"{base}#/collections/{slug}", wait_until="commit")
            clicked = 'hash'
    if clicked:
        await page.wait_for_timeout(wait)
    return bool(clicked)
```

## Escaping the New Post Editor

`history.back()` and `location.hash =` both fail to navigate away from the new post editor — they either do nothing or trigger a full page reload (which shows a 3rd mock installation flow).

**Reliable escape:** Detect when still in editor after save, then reload and re-authenticate:

```python
body_text = await page.evaluate("document.body.innerText")
if "Creating Post" in body_text or "Editing Post" in body_text:
    await page.reload(wait_until="domcontentloaded")
    await page.wait_for_timeout(5000)
    await click_button(page, "Work with Local Repository", wait=0)
    await wait_for_text(page, "Posts", ms=10000)
```

## Published Toggle `[role="switch"]`

The Sveltia CMS published toggle is **resistant to all programmatic click approaches**:
- Mouse click by coordinate: ignored
- `el.click()` via JS: ignored
- `page.click('[role="switch"]')`: ignored
- `page.click('[role="switch"]', force=True)`: ignored

This appears to be a Sveltia CMS quirk where the Svelte component's event system doesn't respond to synthetic events. Document as known limitation.

## Material Symbols Font (Google Fonts Blocked)

Headless Chromium blocks Google Fonts in some environments, causing icon text (`more_vert`, `add`, etc.) to appear as literal strings instead of icons.

**Fix:** Intercept the font request and serve a local WOFF2 copy:

```python
FONT_URL_PATTERN = re.compile(
    r"fonts\.gstatic\.com.*material.symbols.outlined.*\.woff2", re.IGNORECASE
)

async def handle_route(route: Route, request: Request):
    if FONT_URL_PATTERN.search(request.url):
        await route.fulfill(
            status=200,
            content_type="font/woff2",
            body=Path("admin/vendor/fonts/material-symbols-outlined.woff2").read_bytes(),
            headers={"Access-Control-Allow-Origin": "*"},
        )
    else:
        await route.continue_()

await page.route("**/*", handle_route)
```

Also inject the full `.material-symbols-outlined` CSS via `page.add_style_tag()` to ensure the font-family is wired up.

## IndexedDB Mock (Local Backend)

Sveltia CMS local backend uses IndexedDB for file storage. In headless Playwright, patch `window.IDBFactory` / `window.indexedDB` with a full mock that handles `structured clone` serialization. Key requirement: store values as JSON-serializable copies, not raw objects, to avoid `DataCloneError`.

## Tag Checkbox Detection

Sveltia CMS tag checkboxes don't use wrapping `<label>` elements — `el.closest('label')` returns null. Use a two-strategy approach:

```javascript
// Strategy 1: exact textContent match
for (const el of document.querySelectorAll('span, div, label, li')) {
  if ((el.textContent || '').trim() === 'AI Engineering') {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.y > 60 && r.y < 900)
      return {x: r.x + r.width/2, y: r.y + r.height/2};
  }
}
// Strategy 2: checkbox with ancestor containing the text
for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
  const p = cb.closest('div, li, tr') || cb.parentElement;
  if (p && (p.textContent || '').includes('AI Engineering')) {
    const r = cb.getBoundingClientRect();
    if (r.width > 0 && r.y > 60 && r.y < 900)
      return {x: r.x + r.width/2, y: r.y + r.height/2};
  }
}
```

## Screenshot Timing

- Use `wait_until="commit"` for pre-JS captures
- After button clicks, `wait=0` + 200ms manual delay gives the fastest useful capture
- Toast notifications appear briefly — capture immediately after save action
- Always verify screenshots have unique file sizes to confirm distinct content was captured
