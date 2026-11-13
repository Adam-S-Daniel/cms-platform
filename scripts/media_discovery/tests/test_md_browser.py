"""browser.py without Playwright or a network: the allow decision and the fallback."""

import builtins

from media_discovery.browser import BrowserSession, route_allowed

PUBLIC = "93.184.216.34"


def resolver(address):
    return lambda host, port: [address]


def test_public_document_is_allowed():
    assert route_allowed("https://news.example.com/a", "document", resolver(PUBLIC))
    assert route_allowed("https://news.example.com/app.js", "script", resolver(PUBLIC))


def test_private_and_metadata_addresses_are_refused():
    for address in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.1.1", "::1"):
        assert not route_allowed("https://x.example.com/", "document", resolver(address))


def test_a_host_with_any_private_address_is_refused():
    both = lambda host, port: [PUBLIC, "10.0.0.5"]  # noqa: E731
    assert not route_allowed("https://x.example.com/", "xhr", both)


def test_non_http_schemes_are_refused():
    for url in ("file:///etc/passwd", "ftp://x.example.com/", "data:text/html,hi",
                "chrome://settings", "javascript:alert(1)"):
        assert not route_allowed(url, "document", resolver(PUBLIC))


def test_images_media_and_fonts_are_aborted():
    for kind in ("image", "media", "font"):
        assert not route_allowed("https://x.example.com/a", kind, resolver(PUBLIC))


def test_unresolvable_host_is_refused():
    def boom(host, port):
        raise OSError("nope")
    assert not route_allowed("https://x.example.com/", "document", boom)


def test_fetch_is_none_when_playwright_is_missing(monkeypatch):
    real_import = builtins.__import__

    def fake_import(name, *a, **kw):
        if name.startswith("playwright"):
            raise ImportError(name)
        return real_import(name, *a, **kw)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    with BrowserSession() as session:
        assert session.fetch("https://x.example.com/") is None
        assert session.fetch("https://x.example.com/") is None  # does not retry the launch


def test_route_handler_continues_or_aborts():
    calls = []

    class Req:
        def __init__(self, url, kind):
            self.url, self.resource_type = url, kind

    class Route:
        def __init__(self, url, kind):
            self.request = Req(url, kind)

        def continue_(self):
            calls.append("continue")

        def abort(self):
            calls.append("abort")

    session = BrowserSession(resolver=resolver(PUBLIC))
    session._route(Route("https://x.example.com/", "document"))
    session._route(Route("https://x.example.com/p.png", "image"))
    session._route(Route("file:///etc/passwd", "document"))
    assert calls == ["continue", "abort", "abort"]
