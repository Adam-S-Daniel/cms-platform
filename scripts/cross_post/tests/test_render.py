"""Tests for describe_post, mastodon_status, substack_markdown, and render()."""

import json
from pathlib import Path

import cross_post


CONFIG_TEXT = 'url: "https://adamdaniel.ai"\npermalink: /blog/:slug/\n'


def settings():
    return cross_post.site_settings(CONFIG_TEXT)


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def make_post(front_matter_lines, body="Some body text.\n"):
    fm = "\n".join(front_matter_lines)
    return f"---\n{fm}\n---\n{body}"


# --- describe_post / excerpt fallback chain -------------------------------


def test_excerpt_fallback_uses_excerpt_field_when_present():
    text = make_post(
        ["title: T", "excerpt: The excerpt.", "description: The description."],
        body="First paragraph.\n",
    )
    post = cross_post.describe_post("_posts/2026-01-01-t.md", text, settings())
    assert post["excerpt"] == "The excerpt."


def test_excerpt_fallback_uses_description_when_no_excerpt():
    text = make_post(["title: T", "description: The description."], body="First paragraph.\n")
    post = cross_post.describe_post("_posts/2026-01-01-t.md", text, settings())
    assert post["excerpt"] == "The description."


def test_excerpt_fallback_uses_first_paragraph_when_no_excerpt_or_description():
    body = "## A Heading\n\nThis is the   first real   paragraph.\nSecond line.\n\nSecond paragraph.\n"
    text = make_post(["title: T"], body=body)
    post = cross_post.describe_post("_posts/2026-01-01-t.md", text, settings())
    assert post["excerpt"] == "This is the first real paragraph. Second line."


def test_describe_post_fields():
    text = make_post(
        [
            "title: My Title",
            "date: 2026-05-13 08:51:00 -0400",
            "excerpt: An excerpt.",
            "tags:",
            "  - ai",
            "  - quotes",
            "featured_image: /assets/images/uploads/img.png",
            "published: true",
        ],
        body="Body.\n",
    )
    post = cross_post.describe_post("_posts/2026-05-13-my-title.md", text, settings())
    assert post["path"] == "_posts/2026-05-13-my-title.md"
    assert post["slug"] == "my-title"
    assert post["title"] == "My Title"
    assert post["url"] == "https://adamdaniel.ai/blog/my-title/"
    assert post["date"] != ""
    assert post["excerpt"] == "An excerpt."
    assert post["tags"] == ["ai", "quotes"]
    assert post["featured_image"] == "https://adamdaniel.ai/assets/images/uploads/img.png"


def test_describe_post_missing_optional_fields_default_sensibly():
    text = make_post(["title: My Title"], body="Body text here.\n")
    post = cross_post.describe_post("_posts/2026-05-13-my-title.md", text, settings())
    assert post["date"] == ""
    assert post["tags"] == []
    assert post["featured_image"] == ""


def test_describe_post_featured_image_absolute_url_kept_unchanged():
    text = make_post(
        ["title: My Title", "featured_image: https://cdn.example.com/x.png"],
        body="Body text here.\n",
    )
    post = cross_post.describe_post("_posts/2026-05-13-my-title.md", text, settings())
    assert post["featured_image"] == "https://cdn.example.com/x.png"


def test_describe_post_featured_image_site_relative_path_is_prefixed():
    text = make_post(
        ["title: My Title", "featured_image: /assets/x.png"],
        body="Body text here.\n",
    )
    post = cross_post.describe_post("_posts/2026-05-13-my-title.md", text, settings())
    assert post["featured_image"] == "https://adamdaniel.ai/assets/x.png"


# --- hashtag derivation -------------------------------------------------


def test_hashtag_derivation_multi_word():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/", "excerpt": "", "tags": ["ai engineering"]}
    status = cross_post.mastodon_status(post)
    assert "#AiEngineering" in status


def test_hashtag_derivation_single_word():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/", "excerpt": "", "tags": ["quotes"]}
    status = cross_post.mastodon_status(post)
    assert "#Quotes" in status


def test_hashtag_derivation_dedupes_preserving_order():
    post = {
        "title": "T",
        "url": "https://adamdaniel.ai/blog/t/",
        "excerpt": "",
        "tags": ["ai", "quotes", "ai"],
    }
    status = cross_post.mastodon_status(post)
    hashtag_line = status.strip().splitlines()[-1]
    assert hashtag_line == "#Ai #Quotes"


# --- mastodon_status exact format -------------------------------------------------


def test_mastodon_status_exact_format_with_excerpt_and_tags():
    post = {
        "title": "My Title",
        "url": "https://adamdaniel.ai/blog/my-title/",
        "excerpt": "An excerpt.",
        "tags": ["ai", "quotes"],
    }
    status = cross_post.mastodon_status(post)
    assert status == (
        "My Title\n\nAn excerpt.\n\nhttps://adamdaniel.ai/blog/my-title/\n\n#Ai #Quotes"
    )


def test_mastodon_status_omits_excerpt_block_when_empty():
    post = {"title": "My Title", "url": "https://adamdaniel.ai/blog/my-title/", "excerpt": "", "tags": []}
    status = cross_post.mastodon_status(post)
    assert status == "My Title\n\nhttps://adamdaniel.ai/blog/my-title/"


def test_mastodon_status_omits_hashtags_when_no_tags():
    post = {
        "title": "My Title",
        "url": "https://adamdaniel.ai/blog/my-title/",
        "excerpt": "An excerpt.",
        "tags": [],
    }
    status = cross_post.mastodon_status(post)
    assert status == "My Title\n\nAn excerpt.\n\nhttps://adamdaniel.ai/blog/my-title/"


def test_mastodon_status_length_cap_keeps_title_and_url():
    long_excerpt = " ".join(["word"] * 200)
    post = {
        "title": "A Fixed Title",
        "url": "https://adamdaniel.ai/blog/a-fixed-title/",
        "excerpt": long_excerpt,
        "tags": ["ai", "engineering", "quotes"],
    }
    status = cross_post.mastodon_status(post, max_chars=120)
    assert len(status) <= 120
    assert "A Fixed Title" in status
    assert "https://adamdaniel.ai/blog/a-fixed-title/" in status


def test_mastodon_status_length_cap_drops_hashtags_when_still_too_long():
    long_excerpt = " ".join(["word"] * 200)
    post = {
        "title": "A Fixed Title That Is Somewhat Long For A Status",
        "url": "https://adamdaniel.ai/blog/a-fixed-title/",
        "excerpt": long_excerpt,
        "tags": ["ai", "engineering", "quotes"],
    }
    max_chars = len(post["title"]) + len(post["url"]) + 4  # only room for title + blank + url
    status = cross_post.mastodon_status(post, max_chars=max_chars)
    assert "#" not in status
    assert post["title"] in status
    assert post["url"] in status


def test_mastodon_status_shortens_excerpt_at_word_boundary_with_ellipsis():
    post = {
        "title": "T",
        "url": "https://adamdaniel.ai/blog/t/",
        "excerpt": "one two three four five six seven eight nine ten",
        "tags": [],
    }
    status = cross_post.mastodon_status(post, max_chars=40)
    assert len(status) <= 40
    lines = status.split("\n\n")
    assert lines[0] == "T"
    assert lines[-1] == post["url"]
    # An excerpt block remains and is a word-boundary truncation ending in an ellipsis.
    assert len(lines) == 3
    excerpt_line = lines[1]
    assert excerpt_line.endswith("…")
    # what remains (minus the ellipsis) must be a prefix of whole words from the original
    remainder = excerpt_line[:-1].strip()
    assert post["excerpt"].startswith(remainder)


# --- substack_markdown -------------------------------------------------


def test_substack_markdown_header_and_link_text():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    result = cross_post.substack_markdown(post, "Body.\n")
    assert result.startswith("*Originally published at [adamdaniel.ai](https://adamdaniel.ai/blog/t/).*\n\n")


def test_substack_embed_replacement():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = (
        "Before.\n\n"
        "<!-- html-embed:start -->\n<div>widget</div>\n<!-- html-embed:end -->\n\n"
        "After.\n"
    )
    result = cross_post.substack_markdown(post, body)
    assert "<div>widget</div>" not in result
    assert "*[Interactive version of this section on adamdaniel.ai](https://adamdaniel.ai/blog/t/)*" in result
    assert "Before." in result
    assert "After." in result


def test_substack_relative_to_absolute_md_link():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = "See [related](/blog/other-post/) for more.\n"
    result = cross_post.substack_markdown(post, body)
    assert "[related](https://adamdaniel.ai/blog/other-post/)" in result


def test_substack_relative_to_absolute_md_image():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = "An image ![diagram](/assets/images/uploads/diagram.png) here.\n"
    result = cross_post.substack_markdown(post, body)
    assert "![diagram](https://adamdaniel.ai/assets/images/uploads/diagram.png)" in result


def test_substack_relative_to_absolute_html_src_and_href():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = '<img src="/assets/images/uploads/inline.png" alt="inline"> and <a href="/blog/another/">link</a>\n'
    result = cross_post.substack_markdown(post, body)
    assert 'src="https://adamdaniel.ai/assets/images/uploads/inline.png"' in result
    assert 'href="https://adamdaniel.ai/blog/another/"' in result


def test_substack_protocol_relative_and_absolute_untouched():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = (
        "External [link](https://example.com/x) and "
        "![proto](//cdn.example.com/y.png) and "
        '<a href="//cdn.example.com/z">cdn</a>\n'
    )
    result = cross_post.substack_markdown(post, body)
    assert "[link](https://example.com/x)" in result
    assert "![proto](//cdn.example.com/y.png)" in result
    assert 'href="//cdn.example.com/z"' in result


def test_substack_strips_leading_and_trailing_blank_lines():
    post = {"title": "T", "url": "https://adamdaniel.ai/blog/t/"}
    body = "\n\n  \nActual content.\n\n\n"
    result = cross_post.substack_markdown(post, body)
    assert result.endswith("Actual content.\n")
    assert not result.endswith("\n\n")


def test_substack_markdown_full_fixture():
    text = (FIXTURES_DIR / "post-with-embed.md").read_text(encoding="utf-8")
    meta, body = cross_post.parse_post(text)
    settings_obj = settings()
    slug = cross_post.slug_for("_posts/2026-05-12-introducing-gha-bench.md", meta)
    post = cross_post.describe_post("_posts/2026-05-12-introducing-gha-bench.md", text, settings_obj)
    result = cross_post.substack_markdown(post, body)
    assert "<!-- html-embed:start -->" not in result
    assert "console.log" not in result
    assert "*[Interactive version of this section on adamdaniel.ai]" in result
    assert "https://adamdaniel.ai/blog/gha-bench-writeup/" in result
    assert "https://adamdaniel.ai/blog/other-post/" in result
    assert "https://adamdaniel.ai/assets/images/uploads/diagram.png" in result
    assert 'src="https://adamdaniel.ai/assets/images/uploads/inline.png"' in result
    assert 'href="https://adamdaniel.ai/blog/another/"' in result
    assert "https://example.com/x" in result
    assert "//cdn.example.com/y.png" in result
    assert 'href="//cdn.example.com/z"' in result


# --- render() -------------------------------------------------


def test_render_writes_status_substack_and_meta_files(tmp_path):
    post = {
        "path": "_posts/2026-01-01-t.md",
        "slug": "my-post",
        "title": "My Post",
        "url": "https://adamdaniel.ai/blog/my-post/",
        "date": "2026-01-01",
        "excerpt": "An excerpt.",
        "tags": ["ai"],
        "featured_image": "",
    }

    def read_body(p):
        return "Body content.\n"

    out_dir = tmp_path / "out"
    cross_post.render([post], out_dir, read_body, max_chars=500)

    status_file = out_dir / "my-post.status.txt"
    substack_file = out_dir / "my-post.substack.md"
    meta_file = out_dir / "my-post.meta.json"
    assert status_file.exists()
    assert substack_file.exists()
    assert meta_file.exists()

    assert status_file.read_text(encoding="utf-8") == cross_post.mastodon_status(post, max_chars=500)
    assert substack_file.read_text(encoding="utf-8") == cross_post.substack_markdown(post, "Body content.\n")

    meta = json.loads(meta_file.read_text(encoding="utf-8"))
    assert meta["title"] == "My Post"
    assert meta["subtitle"] == "An excerpt."
    assert meta["url"] == post["url"]
    assert meta["slug"] == "my-post"
    assert meta["date"] == "2026-01-01"
    assert meta["tags"] == ["ai"]
    assert meta["featured_image"] == ""


def test_render_summary_contains_substack_markdown(tmp_path):
    post = {
        "path": "_posts/2026-01-01-t.md",
        "slug": "my-post",
        "title": "My Post",
        "url": "https://adamdaniel.ai/blog/my-post/",
        "date": "2026-01-01",
        "excerpt": "An excerpt.",
        "tags": ["ai"],
        "featured_image": "",
    }

    def read_body(p):
        return "Body content.\n"

    out_dir = tmp_path / "out"
    summary_path = tmp_path / "summary.md"
    summary_path.write_text("# Existing summary\n", encoding="utf-8")

    cross_post.render([post], out_dir, read_body, max_chars=500, summary_path=str(summary_path))

    summary_text = summary_path.read_text(encoding="utf-8")
    assert "# Existing summary" in summary_text
    assert "My Post" in summary_text
    expected_substack = cross_post.substack_markdown(post, "Body content.\n")
    assert expected_substack in summary_text
    assert "<details>" in summary_text


# --- excerpts are plain text: every target renders none of Markdown --------
# LinkedIn little text, Mastodon statuses and Substack's subtitle field all
# show Markdown syntax literally (adamdaniel.ai's 2026-09-28 LinkedIn post
# read "> The more time ... > > We can ...").

WILLISON_BODY = (
    "> The more time I spend working with coding agents, the more convinced I am"
    " that they make software engineering even harder.\n"
    ">\n"
    "> We can do amazing things with them, but unlocking their full potential"
    " requires extraordinary discipline and knowledge.\n"
    "\n"
    "\\- [Simon Willison](https://simonwillison.net/2026/Sep/24/harder/)\n"
)

WILLISON_EXCERPT = (
    "\"The more time I spend working with coding agents, the more convinced I am"
    " that they make software engineering even harder.\n\n"
    "We can do amazing things with them, but unlocking their full potential"
    " requires extraordinary discipline and knowledge.\""
)


def test_first_block_blockquote_becomes_quoted_plain_paragraphs():
    post = cross_post.describe_post(
        "_posts/2026-09-28-q.md", make_post(["title: T"], body=WILLISON_BODY), settings()
    )
    assert post["excerpt"] == WILLISON_EXCERPT


def test_blockquote_already_in_curly_quotes_is_not_double_wrapped():
    body = "> “what I see is context”\n\nAfter.\n"
    post = cross_post.describe_post("_posts/2026-10-01-q.md", make_post(["title: Q"], body=body), settings())
    assert post["excerpt"] == "“what I see is context”"
    # Every target reads post["excerpt"]: Mastodon, the LinkedIn little text, and the article card.
    assert cross_post.mastodon_status(post) == f"Q\n\n“what I see is context”\n\n{post['url']}"
    assert "“what I see is context”" in cross_post.linkedin_commentary(post)
    assert '"“' not in cross_post.linkedin_commentary(post)


def test_blockquote_already_in_straight_quotes_is_not_double_wrapped():
    body = '> "already quoted"\n\nAfter.\n'
    post = cross_post.describe_post("_posts/2026-10-01-q.md", make_post(["title: Q"], body=body), settings())
    assert post["excerpt"] == '"already quoted"'


def test_unquoted_blockquote_is_still_wrapped_in_straight_quotes():
    post = cross_post.describe_post(
        "_posts/2026-10-01-q.md", make_post(["title: Q"], body="> plain words\n\nAfter.\n"), settings()
    )
    assert post["excerpt"] == '"plain words"'


def test_first_paragraph_inline_markup_is_stripped():
    body = "This has **bold**, _italic_, `code`, a [link](https://example.com) and \\*stars\\*.\n"
    post = cross_post.describe_post("_posts/2026-01-01-t.md", make_post(["title: T"], body=body), settings())
    assert post["excerpt"] == "This has bold, italic, code, a link and *stars*."


def test_first_paragraph_skips_leading_html_and_images():
    body = '<div class="x">embed</div>\n\n![alt](/a.png)\n\nReal text.\n'
    post = cross_post.describe_post("_posts/2026-01-01-t.md", make_post(["title: T"], body=body), settings())
    assert post["excerpt"] == "Real text."


def test_first_block_list_becomes_bullets():
    body = "- one\n- two **2**\n\nAfter.\n"
    post = cross_post.describe_post("_posts/2026-01-01-t.md", make_post(["title: T"], body=body), settings())
    assert post["excerpt"] == "• one\n• two 2"


def test_front_matter_excerpt_markdown_is_stripped():
    text = make_post(["title: T", "excerpt: 'A **bold** [claim](https://example.com).'"])
    post = cross_post.describe_post("_posts/2026-01-01-t.md", text, settings())
    assert post["excerpt"] == "A bold claim."


def test_mastodon_status_for_a_quote_post_has_no_markdown():
    post = cross_post.describe_post(
        "_posts/2026-09-28-q.md", make_post(["title: Q"], body=WILLISON_BODY), settings()
    )
    status = cross_post.mastodon_status(post)
    assert status == f"Q\n\n{WILLISON_EXCERPT}\n\n{post['url']}"


# --- Substack: its editor does not convert pasted Markdown ----------------


def test_substack_html_renders_the_transformed_markdown():
    post = {"url": "https://adamdaniel.ai/blog/q/", "title": "Q & A"}
    html = cross_post.substack_html(post, "An **essay** with a [rel](/about/) link.\n\n> A quote.\n")
    assert "<title>Q &amp; A</title>" in html
    assert "<strong>essay</strong>" in html
    assert "<blockquote>" in html
    assert '<a href="https://adamdaniel.ai/about/">rel</a>' in html
    assert '<a href="https://adamdaniel.ai/blog/q/">adamdaniel.ai</a>' in html


# A quotation post (its first block is a blockquote) renders as the Substack
# Note the owner posted by hand for the 2026-09-28 Simon Willison post: bold
# title, the quote, then the post URL. The attribution line and the
# "Originally published at" header are left out; the link card carries both.


def _html_body(page: str) -> str:
    return page.split("<body>\n", 1)[1].split("</body>", 1)[0]


def test_substack_html_for_a_quote_post_matches_the_note_layout():
    post = {"url": "https://adamdaniel.ai/blog/q/", "title": "Quoting S & W"}
    html = cross_post.substack_html(post, WILLISON_BODY)
    assert "<title>Quoting S &amp; W</title>" in html
    assert _html_body(html) == (
        "<p><strong>Quoting S &amp; W</strong></p>\n"
        "<blockquote>\n"
        "<p>The more time I spend working with coding agents, the more convinced I am"
        " that they make software engineering even harder.</p>\n"
        "<p>We can do amazing things with them, but unlocking their full potential"
        " requires extraordinary discipline and knowledge.</p>\n"
        "</blockquote>\n"
        '<p><a href="https://adamdaniel.ai/blog/q/">https://adamdaniel.ai/blog/q/</a></p>\n'
    )


def test_substack_html_quote_post_absolutizes_links_inside_the_quote():
    post = {"url": "https://adamdaniel.ai/blog/q/", "title": "Q"}
    html = cross_post.substack_html(post, "> See [this](/about/).\n\nAfter.\n")
    assert '<a href="https://adamdaniel.ai/about/">this</a>' in html
    assert "After." not in html


def test_substack_html_quote_post_skips_a_leading_heading():
    post = {"url": "https://adamdaniel.ai/blog/q/", "title": "Q"}
    html = cross_post.substack_html(post, "## Heading\n\n> Quoted.\n")
    assert "<blockquote>\n<p>Quoted.</p>\n</blockquote>" in html
    assert "Heading" not in _html_body(html)


def test_render_writes_substack_html(tmp_path):
    post = {
        "path": "_posts/2026-01-01-t.md",
        "slug": "my-post",
        "title": "My Post",
        "url": "https://adamdaniel.ai/blog/my-post/",
        "date": "2026-01-01",
        "excerpt": "An excerpt.",
        "tags": [],
        "featured_image": "",
    }
    out_dir = tmp_path / "out"
    cross_post.render([post], out_dir, lambda p: "Body **content**.\n", max_chars=500)
    html_file = out_dir / "my-post.substack.html"
    assert html_file.read_text(encoding="utf-8") == cross_post.substack_html(post, "Body **content**.\n")
