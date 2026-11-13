"""Retry a source in headless Chromium (Playwright) when urllib could not read it.

Some sources need a real browser: pages that build their text with JavaScript,
and servers that refuse non-browser requests (HTTP 403/406). This is plain
headless Chromium with Playwright's default user agent. It adds no stealth,
fingerprint spoofing, or bot-check or CAPTCHA workaround: it renders
JavaScript and sends ordinary browser headers, nothing more.

Every request the page makes (the navigation, each redirect, each subresource)
passes the same public-address check as fetch.py before it leaves the runner;
images, media and fonts are aborted. Service workers are blocked and downloads
are not accepted. Nothing here is ever logged, and nothing raises: when
Playwright or Chromium is missing, fetch() returns None so the run goes on
without the retry.
"""

from . import fetch as fetch_mod
from .corroborate import FetchedPage

NAV_TIMEOUT_MS = 25_000
IDLE_TIMEOUT_MS = 5_000
SKIPPED_RESOURCES = frozenset({"image", "media", "font"})


def route_allowed(url: str, resource_type: str, resolver=None) -> bool:
    """Whether the browser may make this request: not an image, media or font,
    and an http(s) URL whose host resolves only to public addresses."""
    if resource_type in SKIPPED_RESOURCES:
        return False
    return fetch_mod._allowed(url, resolver or fetch_mod._default_resolver)


class BrowserSession:
    """Context manager owning one lazily launched headless Chromium."""

    def __init__(self, resolver=None):
        self._resolver = resolver or fetch_mod._default_resolver
        self._playwright = None
        self._browser = None
        self._failed = False

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def close(self) -> None:
        for closer in (getattr(self._browser, "close", None),
                       getattr(self._playwright, "stop", None)):
            try:
                if closer:
                    closer()
            except Exception:  # noqa: BLE001 - shutdown problems are not findings
                pass
        self._browser = self._playwright = None

    def _launch(self) -> bool:
        if self._browser is not None:
            return True
        if self._failed:
            return False
        try:
            from playwright.sync_api import sync_playwright
            self._playwright = sync_playwright().start()
            self._browser = self._playwright.chromium.launch(headless=True)
            return True
        except Exception:  # noqa: BLE001 - Playwright or Chromium missing
            self._failed = True
            self.close()
            return False

    def _route(self, route) -> None:
        try:
            request = route.request
            if route_allowed(request.url, request.resource_type, self._resolver):
                route.continue_()
            else:
                route.abort()
        except Exception:  # noqa: BLE001 - a route that cannot answer is dropped
            try:
                route.abort()
            except Exception:  # noqa: BLE001
                pass

    def fetch(self, url: str) -> FetchedPage | None:
        """Render `url`. None when the browser is unavailable; a status-0 page
        with no text on any navigation failure. Never raises."""
        if not self._launch():
            return None
        context = None
        try:
            context = self._browser.new_context(service_workers="block", accept_downloads=False)
            context.route("**/*", self._route)
            page = context.new_page()
            page.route("**/*", self._route)
            response = page.goto(url, timeout=NAV_TIMEOUT_MS, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=IDLE_TIMEOUT_MS)
            except Exception:  # noqa: BLE001 - a page that never idles is still read
                pass
            text = page.inner_text("body")[:fetch_mod.MAX_BYTES]
            status = response.status if response is not None else 0
            return FetchedPage(url, page.url, status, text)
        except Exception:  # noqa: BLE001 - a browser failure is data, not a crash
            return FetchedPage(url, url, 0, "")
        finally:
            try:
                if context is not None:
                    context.close()
            except Exception:  # noqa: BLE001
                pass
