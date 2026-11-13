import re
import string
from datetime import date

import pytest
import yaml
from md_fixtures import CFG, PAGE_A, PAGE_B, make_candidate, page

from media_discovery.config import load_config
from media_discovery.corroborate import Problem, verify
from media_discovery.render import (WORD_JOINER, _clean, render_digest, render_entry, render_pr,
                                    safe_md, slugify)


def front(entry):
    assert entry.content.startswith("---\n") and entry.content.endswith("\n---\n")
    return yaml.safe_load(entry.content[len("---\n"):-len("---\n")])


@pytest.mark.parametrize("raw,expected", [
    ("Open Data \u2014 In Practice", "open-data-in-practice"),
    ("Caf\u00e9 R\u00e9sum\u00e9 Stra\u00dfe", "cafe-resume-strasse"),
    ("!!! ??? ---", "item"),
    ("", "item"),
    ("\u2014\u2014", "item"),
])
def test_slugify(raw, expected):
    assert slugify(raw) == expected


def test_slugify_caps_on_dash_boundary():
    s = slugify("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo", 30)
    assert s == "alpha-bravo-charlie-delta-echo" and len(s) <= 30
    assert slugify("a" * 100, 10) == "a" * 10
    assert slugify("abcde fghij", 5) == "abcde"


def test_media_entry():
    c = make_candidate(kind="podcast", title='Say "Hi" \\ now', outlet="Example Radio\n",
                       date="2026-05")
    e = render_entry(c, "podcast", CFG)
    assert (e.collection, e.slug, e.path, e.branch) == (
        "media", "1-say-hi-now", "_media/1-say-hi-now.md", "cms/media/1-say-hi-now")
    assert list(front(e)) == [
        "category", "title", "source", "date_display", "article_url", "weight"]
    assert type(front(e)["weight"]) is int
    assert front(e) == {
        "category": "Podcasts & Interviews", "title": 'Say "Hi" \\ now',
        "source": "Example Radio", "date_display": "May 2026",
        "article_url": c.primary_url, "weight": 1}


@pytest.mark.parametrize("kind,category", [
    ("past_talk", "Talks & Panels"), ("press", "Press Coverage"),
    ("authored_article", "Articles & Commentary"),
    ("brief_testimony", "Briefs, Testimony & Reports"),
])
def test_media_categories(kind, category):
    assert front(render_entry(make_candidate(kind=kind), kind, CFG))["category"] == category


def test_media_uses_configured_folder_and_weight():
    cfg = load_config("person: {names: [A B], identity_markers: [X]}\n"
                      "collections: {media: {folder: media_items, weight: 7}}")
    e = render_entry(make_candidate(), "past_talk", cfg)
    assert e.path == "media_items/7-open-data-in-practice.md" and front(e)["weight"] == 7


def test_event_entry_round_trip():
    c = make_candidate(kind="upcoming_talk", date="2026-12-03", location="Springfield: Hall A",
                       session="Panel #2", title="Data \u2013 Next")
    e = render_entry(c, "upcoming_talk", CFG)
    assert (e.collection, e.slug, e.branch) == (
        "events", "2026-12-03-data-next", "cms/events/2026-12-03-data-next")
    assert e.path == "_events/2026-12-03-data-next.md"
    assert list(front(e)) == [
        "title", "org", "start_date", "date_display", "location", "session", "event_url"]
    assert type(front(e)["start_date"]) is str
    assert front(e) == {
        "title": "Data \u2013 Next", "org": "Example Summit", "start_date": "2026-12-03",
        "date_display": "December 3, 2026", "location": "Springfield: Hall A",
        "session": "Panel #2", "event_url": c.primary_url}


def test_ampersand_in_title_still_renders():
    e = render_entry(make_candidate(kind="press", title="Crowell & Moring"), "press", CFG)
    assert front(e)["title"] == "Crowell & Moring"


def event_display(**kw):
    c = make_candidate(kind="upcoming_talk", **kw)
    return front(render_entry(c, "upcoming_talk", CFG))["date_display"]


def test_event_ranges():
    assert event_display(date="2026-12-03", end_date="2026-12-05") == "December 3 \u2013 5, 2026"
    assert event_display(date="2026-12-30", end_date="2027-01-02") == \
        "December 30, 2026 \u2013 January 2, 2027"
    assert event_display(date="2026-11-30", end_date="2026-12-02") == \
        "November 30 \u2013 December 2, 2026"
    assert event_display(date="2026-12-03", end_date="2026-12-03") == "December 3, 2026"


def test_event_requires_full_date():
    with pytest.raises(ValueError):
        render_entry(make_candidate(kind="upcoming_talk", date="2026-12"), "upcoming_talk", CFG)


def test_values_have_no_newlines_or_control_chars_and_are_capped():
    c = make_candidate(title="a\nb\x00c\u2028d" + "z" * 500, outlet="x:\ty")
    f = front(render_entry(c, "press", CFG))
    assert f["title"].startswith("a bc d") and len(f["title"]) <= 300
    assert f["source"] == "x: y"


def test_safe_md_neutralizes_mentions_and_references():
    out = safe_md("Closes #12 thanks @octocat, see GH-7 and https://example.com/x")
    assert out == (f"Closes \\#{WORD_JOINER}12 thanks \\@{WORD_JOINER}octocat\\, see "
                   f"GH\\-{WORD_JOINER}7 and https\\:\\/{WORD_JOINER}\\/example\\.com\\/x")
    assert "#12" not in out and "@octocat" not in out


def test_safe_md_escapes_every_ascii_punctuation_character():
    # CommonMark 0.31.2 section 2.4: any ASCII punctuation character may be escaped.
    assert len(string.punctuation) == 32
    for ch in string.punctuation:
        assert safe_md(f"a{ch}b").replace(WORD_JOINER, "") == f"a\\{ch}b", ch
    assert safe_md("<b>[x](y)|`z`\x07\n*tag*") == "\\<b\\>\\[x\\]\\(y\\)\\|\\`z\\` \\*tag\\*"
    assert "<script>" not in safe_md("<script>alert(1)</script>")
    assert "<" not in re.sub(r"\\<", "", safe_md("<script>x</script>"))
    assert len(safe_md("a" * 1000)) == 600
    assert safe_md("\\|") == "\\\\\\|"


def test_safe_md_word_joiners_survive_the_escaping():
    out = safe_md("@octocat #12 GH-3 https://example.com")
    assert out == (f"\\@{WORD_JOINER}octocat \\#{WORD_JOINER}12 GH\\-{WORD_JOINER}3 "
                   f"https\\:\\/{WORD_JOINER}\\/example\\.com")


HOSTILE = [
    'He said "hi" \\ bye', "key: value # not a comment", "- dash start", "&anchor *alias",
    "!!python/object:os.system", "{{ site.x }} {% raw %}", "<script>alert(1)</script>",
    "'single' quotes", "@user #12 GH-3 https://example.com", "true", "null", "2026-12-03",
    "[a, b]", "| literal", "> folded", "caf\u00e9 \u2013 \u4e2d", "a\u202eb\nc",
    "1,000", "+1,000", "0,1", "0o17", "1e5", "1.5e3",
]


@pytest.mark.parametrize("value", HOSTILE)
def test_front_matter_round_trips_hostile_values(value):
    want = _clean(value, 300)
    m = front(render_entry(make_candidate(kind="press", title=value, outlet=value),
                           "press", CFG))
    assert m["title"] == want and m["source"] == want
    ev = front(render_entry(
        make_candidate(kind="upcoming_talk", date="2026-12-03", title=value, outlet=value,
                       location=value, session=value), "upcoming_talk", CFG))
    assert [ev[k] for k in ("title", "org", "location", "session")] == [want] * 4
    assert ev["start_date"] == "2026-12-03" and type(ev["start_date"]) is str


def test_every_string_value_is_double_quoted_and_weight_is_plain():
    for entry in (render_entry(make_candidate(kind="press", title="1,000", outlet="1e5"),
                               "press", CFG),
                  render_entry(make_candidate(kind="upcoming_talk", date="2026-12-03",
                                              title="0o17", outlet="x", location="y",
                                              session="z"), "upcoming_talk", CFG)):
        events = list(yaml.parse(entry.content[len("---\n"):-len("---\n")]))
        scalars = [e for e in events if isinstance(e, yaml.ScalarEvent)]
        pairs = list(zip(scalars[0::2], scalars[1::2]))
        assert pairs and all(k.style is None for k, _ in pairs)
        for key, val in pairs:
            if key.value == "weight":
                assert val.style is None
            else:
                assert val.style == '"', key.value


def build_pr(**kw):
    c = make_candidate(**kw)
    pages = {c.primary_url: page(c.primary_url, PAGE_A),
             c.supporting_urls[0]: page(c.supporting_urls[0], PAGE_B)}
    v = verify(c, pages, CFG)
    e = render_entry(c, "past_talk", CFG)
    return c, render_pr(c, "past_talk", e, v, "https://admin.example.com/#/collections/media")


def test_pr_shape():
    c, (title, body) = build_pr()
    assert title == "Create Media \u201c1-open-data-in-practice\u201d"
    lines = body.splitlines()
    assert lines[0] == "<!-- media-discovery:v1 url=https://events.example.com/talks/open-data -->"
    assert not body.startswith("Automatically generated by Decap CMS")
    assert lines[2] == "## TLDR"
    assert lines[4].startswith("Found by the weekly media search: Open Data in Practice, "
                               "Example Summit, 2026\\-03\\-12. Publish it in /admin")
    assert "| <https://events.example.com/talks/open-data> | example\\.com | " \
           "Northwind Legal |" in body
    assert "## Why the model thinks it is this person" in body
    assert body.rstrip().endswith("<https://admin.example.com/#/collections/media>")
    ev = render_entry(make_candidate(kind="upcoming_talk", date="2026-12-03"),
                      "upcoming_talk", CFG)
    assert render_pr(c, "upcoming_talk", ev, verify(c, {}, CFG), "x")[0].startswith(
        "Create Events ")


def test_pr_sanitizes_web_text():
    _, (_, body) = build_pr(reasoning="Fixes #99 cc @octocat <script>", title="Open Data in Practice")
    assert "#99" not in body and "@octocat" not in body and "<script>" not in body


def test_pr_non_http_url_is_not_a_link():
    c = make_candidate()
    v = verify(c, {}, CFG)
    v.sources[0].url = "javascript:alert(1)"
    _, body = render_pr(c, "past_talk", render_entry(c, "past_talk", CFG), v, "https://a.example.com/")
    assert "<javascript" not in body


def test_format_characters_are_stripped_before_safe_md_adds_word_joiners():
    # U+202E RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE, U+2066 LEFT-TO-RIGHT
    # ISOLATE and a word joiner smuggled in by the page itself: all category Cf.
    raw = "Open‮ Data​ in⁦ Practice⁠ @octocat"
    f = front(render_entry(make_candidate(title=raw), "press", CFG))
    assert f["title"] == "Open Data in Practice @octocat"
    out = safe_md(raw)
    assert out == f"Open Data in Practice \\@{WORD_JOINER}octocat"
    assert out.count(WORD_JOINER) == 1 and "‮" not in out and "​" not in out


def _problems(*items):
    return [Problem(*i) for i in items]


def test_digest_is_none_when_there_is_nothing_to_say():
    assert render_digest("site.example.com", "Pat Rivera", [], []) is None
    # A preview run ignores drafts, a normal run ignores would-add finds.
    assert render_digest("s", "p", [make_candidate()], [], preview=True) is None
    assert render_digest("s", "p", [], [], [make_candidate()]) is None


def test_digest_subject_starts_with_the_site_and_counts():
    c = make_candidate()
    one = render_digest("site.example.com", "Pat Rivera", [c], [(c, [])])[0]
    assert one == "site.example.com media search: 1 new item for the site, 1 to double-check"
    assert render_digest("s", "p", [c, c, c], [])[0] == "s media search: 3 new items for the site"
    assert render_digest("s", "p", [], [(c, [])] * 2)[0] == "s media search: 2 to double-check"
    assert render_digest("s", "p", [], [], [c], preview=True)[0] == \
        "s media search: 1 new item for the site (preview)"


def test_digest_normal_run_points_at_the_editor_in_plain_words():
    c = make_candidate()
    _, text = render_digest("site.example.com", "Pat Rivera", [c], [],
                            review_link="https://site.example.com/admin/#/workflow")
    assert "READY TO ADD (1)" in text and "Open Data in Practice" in text
    assert "Example Summit · March 12, 2026" in text
    assert "https://site.example.com/admin/#/workflow" in text
    assert "draft addition in the website editor" in text
    for jargon in ("pull request", "_media/", "email-only", "PREVIEW"):
        assert jargon not in text


def test_digest_preview_run_says_what_differs_from_a_normal_run():
    c = make_candidate()
    _, text = render_digest("s", "Pat Rivera", [], [], [c], preview=True)
    assert "nothing on the website was changed" in text
    assert "PREVIEW RUN VS. NORMAL RUN" in text
    assert "Only in this preview run:" in text and "Only in a normal run:" in text
    assert "In a normal run, this would be waiting for you" in text


@pytest.mark.parametrize("problem,expected", [
    (("unreadable-type", "https://events.example.com/talks/open-data"),
     "• The main link is a file (such as a PDF) the search can't read yet."),
    (("http-status", "https://events.example.com/talks/open-data", "406"),
     "• The main link turned away the search's automatic check."),
    (("http-status", "https://events.example.com/talks/open-data", "0"),
     "• The main link couldn't be reached."),
    (("identity", "https://events.example.com/talks/open-data", "no-name"),
     "• The main link doesn't show Pat Rivera's name."),
    (("identity", "https://events.example.com/talks/open-data", "no-identity-marker"),
     "• The main link names Pat Rivera, but nothing near the name"),
    (("no-match", "https://news.example.org/summit-recap"),
     "• This other page mentions Pat Rivera, but doesn't name this item"),
    (("no-second-source",), "• Only one website backed it up"),
    (("internal-error",), "• Something went wrong while checking it."),
])
def test_digest_explains_each_problem_in_plain_words(problem, expected):
    _, text = render_digest("s", "Pat Rivera", [], [(make_candidate(), _problems(problem))])
    assert "COULDN'T CONFIRM (1)" in text and "1. Open Data in Practice" in text
    assert expected in text


def test_digest_puts_every_url_alone_on_its_line():
    """Apple Mail treats a colon right after a URL as part of it."""
    c = make_candidate()
    _, text = render_digest("s", "Pat Rivera", [c], [(c, _problems(
        ("unreadable-type", c.primary_url), ("no-match", "https://news.example.org/a"),
        ("http-status", "https://other.example.net/b", "403")))],
        review_link="https://a.example.com/x")
    url_lines = [line for line in text.splitlines() if "://" in line]
    assert len(url_lines) == 5
    assert all(re.fullmatch(r"https://\S+", line) for line in url_lines)
    # Entries are separated by blank lines.
    assert "\n\n\n1. Open Data in Practice\n" in text


def test_digest_never_shows_a_non_web_link():
    c = make_candidate(primary_url="javascript:alert(1)", title="T‮X\nY")
    _, text = render_digest("s", "p", [], [(c, [])])
    assert "javascript:" not in text and "(link not shown: not a web address)" in text
    assert "‮" not in text and "1. TX Y" in text
