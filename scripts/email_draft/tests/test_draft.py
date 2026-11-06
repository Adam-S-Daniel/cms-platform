"""Tests for draft.py: the Decap slug port, body extraction, images and the post file."""

import datetime
import email.policy
import json
import re
import zoneinfo
from email.message import EmailMessage
from email.parser import BytesParser
from pathlib import Path

import draft
import pytest
import yaml

GOLDEN = json.loads(
    (Path(__file__).parent / "fixtures" / "decap_slug_golden.json").read_text(encoding="utf-8")
)
CONFIG_BASE = Path(__file__).resolve().parents[3] / "theme" / "admin" / "config.base.yml"
SENT = datetime.datetime(2026, 11, 6, 2, 30, tzinfo=datetime.timezone.utc)
NY = zoneinfo.ZoneInfo("America/New_York")
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


def parse(msg: EmailMessage) -> email.message.Message:
    return BytesParser(policy=email.policy.default).parsebytes(msg.as_bytes())


def message(subject="Hello World", text=None, html=None):
    msg = EmailMessage()
    msg["Subject"] = subject
    if text is not None:
        msg.set_content(text)
    if html is not None:
        if text is None:
            msg.set_content(html, subtype="html")
        else:
            msg.add_alternative(html, subtype="html")
    return msg


# ---- slug parity -----------------------------------------------------------


def test_golden_is_from_real_decap_with_this_platforms_settings():
    # The base config carries {{CMS_*}} render-time placeholders, which are not valid YAML values.
    text = re.sub(r"\{\{CMS_[A-Z_]+\}\}", "placeholder", CONFIG_BASE.read_text(encoding="utf-8"))
    cfg = yaml.safe_load(text)
    posts = next(c for c in cfg["collections"] if c["name"] == "posts")
    assert GOLDEN["generated_by"] == "scripts/email_draft/tests/generate_slug_golden.cjs"
    assert GOLDEN["template"] == posts["slug"]
    assert GOLDEN["slug"] == cfg["slug"]
    assert len(GOLDEN["cases"]) >= 20


@pytest.mark.parametrize("title, expected", GOLDEN["cases"])
def test_slug_matches_decap(title, expected):
    assert f"{GOLDEN['date_utc']}-{draft.decap_title_slug(title)}" == expected


def test_truncation_keeps_81_characters_and_cuts_82():
    assert draft.decap_title_slug("x" * 81) == "x" * 81
    assert draft.decap_title_slug("x" * 82) == "x" * 80


# ---- body extraction -------------------------------------------------------


def test_plain_text_body_and_signature_strip():
    msg = message(text="Hello there.\n\nSecond line.\n\n-- \nOwner\nPhone 555\n")
    parsed = draft.parse_email(parse(msg), SENT)
    assert parsed.title == "Hello World"
    assert parsed.body == "Hello there.\n\nSecond line."


def test_double_dash_without_space_is_not_a_signature():
    parsed = draft.parse_email(parse(message(text="Keep\n--\nthis\n")), SENT)
    assert parsed.body == "Keep\n--\nthis"


def test_subject_rfc2047_decoded_and_whitespace_collapsed():
    raw = (
        b"Subject: =?utf-8?q?Caf=C3=A9?=   notes\r\n\tagain\r\n"
        b"Content-Type: text/plain\r\n\r\nBody\r\n"
    )
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    assert draft.parse_email(msg, SENT).title == "Café notes again"


def test_charset_is_decoded():
    raw = (
        b"Subject: x\r\nContent-Type: text/plain; charset=iso-8859-1\r\n"
        b"Content-Transfer-Encoding: 8bit\r\n\r\nna\xefve\r\n"
    )
    msg = BytesParser(policy=email.policy.default).parsebytes(raw)
    assert draft.parse_email(msg, SENT).body == "naïve"


def test_empty_subject_fails():
    with pytest.raises(draft.ContentError, match="subject"):
        draft.parse_email(parse(message(subject="   ", text="Body")), SENT)


def test_empty_body_fails():
    with pytest.raises(draft.ContentError, match="no text"):
        draft.parse_email(parse(message(text="\n-- \nsig only\n")), SENT)


def test_plain_text_preferred_over_html():
    msg = message(text="Plain wins.", html="<p>HTML loses.</p>")
    assert draft.parse_email(parse(msg), SENT).body == "Plain wins."


def test_html_only_becomes_markdown():
    html = (
        "<html><head><style>p{color:red}</style><title>t</title></head><body>"
        "<p>One <b>bold</b> and <i>italic</i> and <a href='https://example.com/x'>a link</a>.</p>"
        "<p>Line one<br>Line two</p>"
        "<ul><li>first</li><li>second <strong>item</strong></li></ul>"
        "<ol><li>alpha</li><li>beta</li></ol>"
        "<blockquote><p>Quoted</p><p>twice</p></blockquote>"
        "<script>alert(1)</script><table><tr><td>cell</td></tr></table>"
        "<a href='javascript:alert(1)'>bad link</a>"
        "</body></html>"
    )
    md = draft.html_to_markdown(html)
    assert md == (
        "One **bold** and *italic* and [a link](https://example.com/x).\n\n"
        "Line one  \nLine two\n\n"
        "- first\n- second **item**\n\n"
        "1. alpha\n2. beta\n\n"
        "> Quoted\n>\n> twice\n\n"
        "cell\n\n"
        "bad link"
    )


def test_nested_list_is_indented():
    md = draft.html_to_markdown("<ul><li>outer<ul><li>inner</li></ul></li></ul>")
    assert md == "- outer\n\n  - inner"


# ---- images and the post file ---------------------------------------------


def with_images(msg, count, *, ctype=("image", "png"), data=PNG, inline_cid=None):
    for n in range(count):
        cid = f"<{inline_cid}>" if inline_cid and n == 0 else None
        msg.add_attachment(data, maintype=ctype[0], subtype=ctype[1], filename=f"p{n}.png", cid=cid)
    return msg


def test_build_post_files_front_matter_and_images():
    msg = message(subject="Fall: colors & leaves", text="Look at these.\n")
    with_images(msg, 2)
    msg.add_attachment(b"%PDF", maintype="application", subtype="pdf", filename="notes.pdf")
    parsed = draft.parse_email(parse(msg), SENT)
    post = draft.build_post(parsed, NY)

    # 02:30 UTC on Nov 6 is 21:30 on Nov 5 in New York.
    assert post.entry_name == "2026-11-05-fall-colors-leaves"
    assert post.path == "_posts/2026-11-05-fall-colors-leaves.md"
    assert list(post.files) == [
        "_posts/2026-11-05-fall-colors-leaves.md",
        "assets/images/uploads/fall-colors-leaves-1.png",
        "assets/images/uploads/fall-colors-leaves-2.png",
    ]
    assert post.skipped_attachments == ["notes.pdf"]
    text = post.files[post.path].decode("utf-8")
    front, body = text.split("---\n")[1], text.split("---\n", 2)[2]
    meta = yaml.safe_load(front)
    assert list(meta) == [
        "title",
        "slug",
        "date",
        "featured_image",
        "published",
        "test_fixture",
    ]
    assert meta == {
        "title": "Fall: colors & leaves",
        "slug": "fall-colors-leaves",
        "date": "2026-11-05 21:30:00 -0500",
        "featured_image": "/assets/images/uploads/fall-colors-leaves-1.png",
        "published": True,
        "test_fixture": False,
    }
    assert body == (
        "\nLook at these.\n\n"
        "![](/assets/images/uploads/fall-colors-leaves-1.png)\n\n"
        "![](/assets/images/uploads/fall-colors-leaves-2.png)\n"
    )


def test_inline_cid_image_lands_where_the_html_put_it():
    msg = message(
        subject="Inline", html='<p>Before</p><img src="cid:pic1@example.com"><p>After</p>'
    )
    with_images(msg, 1, ctype=("image", "jpeg"), inline_cid="pic1@example.com")
    post = draft.build_post(draft.parse_email(parse(msg), SENT), datetime.timezone.utc)
    body = post.files[post.path].decode("utf-8").split("---\n", 2)[2]
    assert body == "\nBefore\n\n![](/assets/images/uploads/inline-1.jpg)\n\nAfter\n"


def test_suffix_changes_slug_and_file_names():
    msg = with_images(message(subject="Same title", text="Body"), 1)
    post = draft.build_post(draft.parse_email(parse(msg), SENT), datetime.timezone.utc, 2)
    assert post.entry_name == "2026-11-06-same-title-2"
    assert "assets/images/uploads/same-title-2-1.png" in post.files
    assert "slug: same-title-2\n" in post.files[post.path].decode("utf-8")


def test_no_images_means_no_featured_image():
    post = draft.build_post(draft.parse_email(parse(message(text="Body")), SENT), NY)
    assert "featured_image" not in post.files[post.path].decode("utf-8")


def test_title_with_no_ascii_letters_fails():
    parsed = draft.parse_email(parse(message(subject="日本語", text="Body")), SENT)
    with pytest.raises(draft.ContentError, match="letter or digit"):
        draft.build_post(parsed, NY)


def test_too_many_images_fails():
    msg = with_images(message(text="Body"), draft.MAX_IMAGES + 1)
    with pytest.raises(draft.ContentError, match="at most 10"):
        draft.parse_email(parse(msg), SENT)


def test_oversized_image_fails():
    msg = with_images(message(text="Body"), 1, data=b"x" * (draft.MAX_IMAGE_BYTES + 1))
    with pytest.raises(draft.ContentError, match="10 MB"):
        draft.parse_email(parse(msg), SENT)


def test_yaml_quotes_hostile_titles():
    for title in ["yes", "- dash", "#hash", "a: b", "'quoted'", "@at", "2026-01-01"]:
        parsed = draft.ParsedEmail(title + " post", "Body", [], [], SENT)
        post = draft.build_post(parsed, NY)
        meta = yaml.safe_load(post.files[post.path].decode("utf-8").split("---\n")[1])
        assert meta["title"] == title + " post"


def test_admin_link():
    assert (
        draft.admin_link("https://example.com/", "2026-11-06-x")
        == "https://example.com/admin/#/collections/posts/entries/2026-11-06-x"
    )
