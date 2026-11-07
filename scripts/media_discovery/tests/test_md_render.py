import re
import string
from datetime import date

import pytest
import yaml
from md_fixtures import CFG, PAGE_A, PAGE_B, make_candidate, page

from media_discovery.config import load_config
from media_discovery.corroborate import verify
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


def test_digest():
    assert render_digest("Example Site", [], []) is None
    subject, text = render_digest(
        "Example Site",
        [("Create Media \u201c1-a\u201d", "https://github.example.com/pr/1",
          "https://admin.example.com/")],
        [(make_candidate(), ["not fetched: https://example.org/x"])])
    assert subject == "1 new find for Example Site to review"
    assert "https://github.example.com/pr/1" in text and "Why not: not fetched" in text
    only_unconfirmed = render_digest("S", [], [(make_candidate(), [])])
    assert only_unconfirmed[0] == "1 unconfirmed find for S"
    assert render_digest("S", [("t", "u", "a")] * 3, [])[0] == "3 new finds for S to review"


def test_format_characters_are_stripped_before_safe_md_adds_word_joiners():
    # U+202E RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE, U+2066 LEFT-TO-RIGHT
    # ISOLATE and a word joiner smuggled in by the page itself: all category Cf.
    raw = "Open‮ Data​ in⁦ Practice⁠ @octocat"
    f = front(render_entry(make_candidate(title=raw), "press", CFG))
    assert f["title"] == "Open Data in Practice @octocat"
    out = safe_md(raw)
    assert out == f"Open Data in Practice \\@{WORD_JOINER}octocat"
    assert out.count(WORD_JOINER) == 1 and "‮" not in out and "​" not in out


def test_digest_lists_would_open_finds_in_email_only_mode():
    c = make_candidate()
    e = render_entry(c, "past_talk", CFG)
    subject, text = render_digest("Example Site", [], [], [(c, e)])
    assert subject == "1 confirmed find for Example Site (email-only mode)"
    assert "would open a pull request in live mode" in text
    assert "Would add: _media/1-open-data-in-practice.md" in text
    assert c.primary_url in text
    subject, text = render_digest("S", [], [(make_candidate(), ["x"])], [(c, e), (c, e)])
    assert subject == "2 confirmed finds for S (email-only mode)"
    assert "Found but not confirmed" in text
    # Opened PRs still lead the subject when both are present.
    assert render_digest("S", [("t", "u", "a")], [], [(c, e)])[0] == \
        "1 new find for S to review"
