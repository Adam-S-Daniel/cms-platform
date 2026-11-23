"""Page titles: HTML <title>, PDF metadata and the browser's page.title()."""

from test_md_fetch import Opener, Resp, make_pdf, resolver_for

from media_discovery.browser import BrowserSession
from media_discovery.fetch import fetch
from media_discovery.text import html_title


def test_html_title_is_the_first_title_with_whitespace_collapsed():
    html = ("<html><head><title>\n  Annual   Meeting &amp; Expo \t2026\n</title>"
            "<title>second</title></head><body><p>x</p></body></html>")
    assert html_title(html) == "Annual Meeting & Expo 2026"


def test_html_title_is_capped_and_missing_titles_are_empty():
    assert len(html_title("<title>" + "w" * 500 + "</title>")) == 200
    assert html_title("<html><body>no head</body></html>") == ""
    assert html_title("") == ""


def test_html_title_keeps_untrusted_text_raw():
    assert html_title("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>") == \
        "<script>alert(1)</script>"


def test_fetch_fills_the_title_from_html_and_not_from_plain_text():
    html = b"<html><head><title>Panel 4 | Example</title></head><body>Pat Rivera</body></html>"
    op = Opener({"https://a.example.com/p": Resp(html),
                 "https://a.example.com/t": Resp(b"<title>not html</title>", "text/plain")})
    got = fetch("https://a.example.com/p", opener=op, resolver=resolver_for({}))
    assert got.title == "Panel 4 | Example" and "Pat Rivera" in got.text
    assert fetch("https://a.example.com/t", opener=op, resolver=resolver_for({})).title == ""


def pdf_with_title(title: str) -> bytes:
    pdf = make_pdf("Pat Rivera, 2026")
    info = f"<< /Title ({title}) >>".encode()
    # Append an incremental update: a new Info object and trailer pointing at it.
    start = len(pdf)
    out = bytearray(pdf) + b"6 0 obj\n" + info + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n6 1\n%010d 00000 n \n" % start
    out += (b"trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n"
            % (_startxref(pdf), xref))
    return bytes(out)


def _startxref(pdf: bytes) -> int:
    tail = pdf[pdf.rindex(b"startxref") + len(b"startxref"):].split()
    return int(tail[0])


def test_fetch_fills_the_title_from_pdf_metadata():
    pdf = pdf_with_title("Agenda for the Annual Meeting")
    op = Opener({"https://a.example.com/f.pdf": Resp(pdf, "application/pdf")})
    got = fetch("https://a.example.com/f.pdf", opener=op, resolver=resolver_for({}))
    assert got.status == 200 and "Pat Rivera" in got.text
    assert got.title == "Agenda for the Annual Meeting"


def test_a_pdf_without_metadata_has_an_empty_title():
    op = Opener({"https://a.example.com/f.pdf": Resp(make_pdf("Pat Rivera 2026"),
                                                      "application/pdf")})
    got = fetch("https://a.example.com/f.pdf", opener=op, resolver=resolver_for({}))
    assert got.status == 200 and got.title == ""


class FakePage:
    url = "https://x.example.com/final"

    def __init__(self, title):
        self._title = title

    def route(self, *a):
        pass

    def goto(self, *a, **kw):
        return type("R", (), {"status": 200})()

    def wait_for_load_state(self, *a, **kw):
        pass

    def inner_text(self, selector):
        return "Pat Rivera, 2026"

    def title(self):
        if isinstance(self._title, Exception):
            raise self._title
        return self._title


class FakeContext:
    def __init__(self, title):
        self._page = FakePage(title)

    def route(self, *a):
        pass

    def new_page(self):
        return self._page

    def close(self):
        pass


def browser_with(title):
    session = BrowserSession(resolver=lambda host, port: ["93.184.216.34"])
    session._browser = type("B", (), {"new_context": lambda self, **kw: FakeContext(title)})()
    return session


def test_the_browser_records_the_page_title_and_survives_a_failing_one():
    got = browser_with("  Rendered \n Title ").fetch("https://x.example.com/")
    assert got.title == "Rendered Title" and got.status == 200
    assert browser_with(RuntimeError("boom")).fetch("https://x.example.com/").title == ""
