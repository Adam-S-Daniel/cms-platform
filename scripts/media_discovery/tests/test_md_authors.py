"""Bylines and excerpts: html_author, the fetchers' author, identity passages and
corroborate.source_notes. Fictional people and example.* hosts only."""

import pytest
from md_fixtures import CFG, PAGE_A, PAGE_B, make_candidate, page
from test_md_fetch import Opener, Resp, make_pdf, resolver_for
from test_md_titles import _startxref, browser_with

from media_discovery.corroborate import SourceNote, source_notes, verify
from media_discovery.fetch import fetch
from media_discovery.identity import _snippet
from media_discovery.text import clean_author, html_author


@pytest.mark.parametrize("html,expected", [
    ('<meta name="author" content="Sam  Writer">', "Sam Writer"),
    ('<meta property="article:author" content="https://social.example.com/sam">'
     '<meta name="byl" content="By Sam Writer and Lee Editor">', "Sam Writer and Lee Editor"),
    ('<meta name="citation_author" content="Writer, Sam">'
     '<meta name="citation_author" content="Editor, Lee">', "Writer, Sam, Editor, Lee"),
    ('<script type="application/ld+json">{"@graph": [{"@type": "NewsArticle", '
     '"author": [{"@type": "Person", "name": "Sam Writer"}, {"name": "Lee Editor"}]}]}'
     '</script>', "Sam Writer, Lee Editor"),
    ('<script type="application/ld+json">{"author": "Sam Writer"}</script>', "Sam Writer"),
    ('<script type="application/ld+json">{not json</script>', ""),
    ('<meta name="author" content="">', ""),
    ("<p>By Sam Writer</p>", ""),  # only listed bylines count, never body text
    ("", ""),
])
def test_html_author_reads_listed_bylines(html, expected):
    assert html_author("<html><head>" + html + "</head><body>x</body></html>") == expected


def test_html_author_keeps_untrusted_text_raw_and_capped():
    assert html_author('<meta name="author" content="&lt;b&gt;Sam&lt;/b&gt;">') == "<b>Sam</b>"
    assert len(html_author('<meta name="author" content="' + "w" * 500 + '">')) == 120


def test_html_author_lists_at_most_three_distinct_names():
    tags = "".join(f'<meta name="author" content="{n}">' for n in "ABCDA")
    assert html_author(tags) == "A, B, C"


def test_clean_author_drops_web_addresses_and_a_leading_by():
    assert clean_author("https://social.example.com/sam") == ""
    assert clean_author("  by\nSam Writer ") == "Sam Writer"


def test_fetch_fills_the_author_from_html_and_not_from_plain_text():
    html = b'<html><head><meta name="author" content="Sam Writer"></head><body>x</body></html>'
    op = Opener({"https://a.example.com/p": Resp(html),
                 "https://a.example.com/t": Resp(html, "text/plain")})
    assert fetch("https://a.example.com/p", opener=op, resolver=resolver_for({})).author == \
        "Sam Writer"
    assert fetch("https://a.example.com/t", opener=op, resolver=resolver_for({})).author == ""


def test_fetch_fills_the_author_from_pdf_metadata():
    pdf = make_pdf("Pat Rivera, 2026")
    start = len(pdf)
    out = bytearray(pdf) + b"6 0 obj\n<< /Author (Sam Writer) >>\nendobj\n"
    xref = len(out)
    out += b"xref\n6 1\n%010d 00000 n \n" % start
    out += (b"trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R /Prev %d >>\nstartxref\n%d\n%%%%EOF\n"
            % (_startxref(pdf), xref))
    op = Opener({"https://a.example.com/f.pdf": Resp(bytes(out), "application/pdf")})
    got = fetch("https://a.example.com/f.pdf", opener=op, resolver=resolver_for({}))
    assert got.status == 200 and got.author == "Sam Writer"


def test_the_browser_reads_the_author_from_the_rendered_page_and_survives_without_one():
    session = browser_with("T")
    page_cls = type(session._browser.new_context().new_page())
    page_cls.content = lambda self: '<meta name="author" content="Sam Writer">'
    try:
        assert session.fetch("https://x.example.com/").author == "Sam Writer"
    finally:
        del page_cls.content
    assert browser_with("T").fetch("https://x.example.com/").author == ""


def test_snippet_cuts_at_whole_words_and_marks_where_the_page_goes_on():
    text = "alpha beta gamma Pat Rivera delta epsilon zeta"
    assert _snippet(text, (17, 27), 30) == "…gamma Pat Rivera delta…"
    assert _snippet("Pat Rivera spoke.", (0, 10)) == "Pat Rivera spoke."
    # Never drops part of the name, even with no space before it.
    assert _snippet("xxxxxxx(Pat Rivera)yyyyyy", (8, 18), 14) == "…x(Pat Rivera)y…"


def test_source_notes_quote_only_names_tied_to_the_person():
    cand = make_candidate()
    namesake = "https://elsewhere.example.org/namesake"
    cand = make_candidate(supporting_urls=[cand.supporting_urls[0], namesake])
    pages = {cand.primary_url: page(cand.primary_url, PAGE_A),
             cand.supporting_urls[0]: page(cand.supporting_urls[0], PAGE_B),
             namesake: page(namesake, "Open Data in Practice 2026: Pat Rivera, a baker.")}
    pages[cand.primary_url].author = "Sam Writer"
    pages[namesake].author = "Lee Editor"
    notes = source_notes(verify(cand, pages, CFG), pages)
    main = notes[cand.primary_url]
    assert main.author == "Sam Writer" and "Pat Rivera of Northwind Legal" in main.excerpt
    assert "Pat Rivera, Northwind Legal" in notes[cand.supporting_urls[0]].excerpt
    # The namesake page keeps its byline but is never quoted.
    assert notes[namesake] == SourceNote("Lee Editor", "")


def test_source_notes_skip_blocked_failed_and_missing_pages():
    cand = make_candidate()
    pages = {cand.primary_url: page(cand.primary_url, PAGE_A, status=404)}
    pages[cand.primary_url].author = "Sam Writer"
    assert source_notes(verify(cand, pages, CFG), pages) == {}
    assert source_notes(None, pages) == {}
    blocked = make_candidate(primary_url="https://blocked.example.net/p")
    cfg_pages = {blocked.primary_url: page(blocked.primary_url, PAGE_A)}
    v = verify(blocked, cfg_pages, CFG)
    assert v.sources[0].blocked  # blocked.example.net is on the fixture's list
    assert source_notes(v, cfg_pages) == {}
