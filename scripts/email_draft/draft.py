"""Turn a verified email into a Decap-shaped post: file name, front matter, body and images.

Everything here is pure (no network, no clock): the caller passes the parsed message and the
site's time zone, and gets back the files to commit. The slug is an exact port of the name Decap
gives a new post for this platform's `posts` collection (theme/admin/config.base.yml):

    slug: "{{year}}-{{month}}-{{day}}-{{slug | truncate(80, '-')}}"
    slug: {encoding: ascii, clean_accents: true, sanitize_replacement: "-"}

Decap applies the truncate filter (lodash `truncate`) to the RAW title, then runs the result
through `prepareSlug` (trim, lower-case, drop `'`, `.` -> `-`) and `sanitizeSlug` (diacritics
removal, the ASCII URI character class, the `sanitize-filename` package, then collapsing and
trimming the replacement). tests/fixtures/decap_slug_golden.json is produced by the real Decap
code (tests/generate_slug_golden.cjs) and test_draft.py checks this port against every case.
"""

from __future__ import annotations

import dataclasses
import datetime
import email.message
import json
import re
from html.parser import HTMLParser
from pathlib import Path

import yaml

UPLOAD_DIR = "assets/images/uploads"
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
MAX_IMAGES = 10
MAX_IMAGE_BYTES = 10 * 1024 * 1024
TITLE_CAP = 80


class ContentError(Exception):
    """The email cannot become a post; `reason` is safe to send to the owner."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# --------------------------------------------------------------------------
# Decap slug port
# --------------------------------------------------------------------------

_DIACRITICS = json.loads(
    (Path(__file__).resolve().parent / "diacritics_map.json").read_text(encoding="utf-8")
)["map"]

# JS String.prototype.trim: WhiteSpace (incl. U+FEFF and category Zs) and LineTerminator.
_JS_WS = "\t\n\v\f\r    -     　﻿"
_JS_TRIM_RE = re.compile(f"^[{_JS_WS}]+|[{_JS_WS}]+$")

# lodash's reHasUnicode / reUnicode, applied to a string of UTF-16 code units (see _units).
_COMBO = "̀-ͯ︠-︯⃐-⃿"
_HAS_UNICODE_RE = re.compile(f"[‍\ud800-\udfff{_COMBO}︎️]")
_FITZ = "\ud83c[\udffb-\udfff]"
_MODIFIER = f"(?:[{_COMBO}]|{_FITZ})"
_NON_ASTRAL = "[^\ud800-\udfff]"
_REGIONAL = "(?:\ud83c[\udde6-\uddff]){2}"
_SURR_PAIR = "[\ud800-\udbff][\udc00-\udfff]"
_OPT_VAR = "[︎️]?"
_OPT_JOIN = f"(?:‍(?:{_NON_ASTRAL}|{_REGIONAL}|{_SURR_PAIR}){_OPT_VAR}{_MODIFIER}?)*"
_SEQ = _OPT_VAR + _MODIFIER + "?" + _OPT_JOIN
_SYMBOL = f"(?:{_NON_ASTRAL}[{_COMBO}]?|[{_COMBO}]|{_REGIONAL}|{_SURR_PAIR}|[\ud800-\udfff])"
_UNICODE_RE = re.compile(f"{_FITZ}(?={_FITZ})|{_SYMBOL}{_SEQ}")

_FN_ILLEGAL_RE = re.compile(r'[/?<>\\:*|"]')
_FN_CONTROL_RE = re.compile("[\x00-\x1f\x80-\x9f]")
_FN_RESERVED_RE = re.compile(r"^\.+$")
_FN_WINDOWS_RE = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$", re.IGNORECASE)
_URI_CHAR_RE = re.compile(r"[A-Za-z0-9_\-.~]")


def _units(s: str) -> str:
    """`s` as a string of UTF-16 code units (astral characters become surrogate pairs)."""
    data = s.encode("utf-16-le", "surrogatepass")
    return "".join(chr(int.from_bytes(data[i : i + 2], "little")) for i in range(0, len(data), 2))


def _from_units(u: str) -> str:
    data = b"".join(ord(c).to_bytes(2, "little") for c in u)
    return data.decode("utf-16-le", "surrogatepass")


def _lodash_truncate(s: str, length: int, omission: str) -> str:
    u = _units(s)
    symbols = _UNICODE_RE.findall(u) if _HAS_UNICODE_RE.search(u) else None
    str_length = len(symbols) if symbols is not None else len(u)
    if length >= str_length:
        return s
    end = length - len(_units(omission))
    if end < 1:
        return omission
    result = "".join(symbols[:end]) if symbols is not None else u[:end]
    return _from_units(result) + omission


def _sanitize_filename_pass(s: str, replacement: str) -> str:
    s = _FN_ILLEGAL_RE.sub(replacement, s)
    s = _FN_CONTROL_RE.sub(replacement, s)
    s = _FN_RESERVED_RE.sub(replacement, s)
    s = _FN_WINDOWS_RE.sub(replacement, s)
    stripped = s.rstrip(". ")
    if len(stripped) < len(s):
        s = stripped + replacement
    out, size = [], 0
    for ch in s:
        size += len(ch.encode("utf-8", "surrogatepass"))
        if size > 255:
            break
        out.append(ch)
    return "".join(out)


def _sanitize_filename(s: str, replacement: str) -> str:
    out = _sanitize_filename_pass(s, replacement)
    return out if replacement == "" else _sanitize_filename_pass(out, "")


def decap_title_slug(title: str) -> str:
    """The title part of Decap's file name for a new post (no date prefix)."""
    value = _lodash_truncate(title, TITLE_CAP + 1, "-")
    # prepareSlug
    value = _JS_TRIM_RE.sub("", value).lower().replace("'", "").replace(".", "-")
    # sanitizeSlug(ascii, clean_accents, "-")
    value = "".join(_DIACRITICS.get(ch, ch) if ord(ch) > 0x7E else ch for ch in value)
    value = "".join(ch if _URI_CHAR_RE.fullmatch(ch) else "-" for ch in value)
    value = _sanitize_filename(value, "-")
    value = re.sub("-+", "-", value)
    value = re.sub("^-", "", value)
    return re.sub("-$", "", value)


# --------------------------------------------------------------------------
# HTML -> Markdown (only the subset an email body needs)
# --------------------------------------------------------------------------

_VOID = {"br", "img", "hr", "meta", "link", "input", "col", "area", "base", "wbr", "source"}
_DROP = {"script", "style", "head", "title", "template", "noscript"}
_BLOCK = {
    "p",
    "div",
    "ul",
    "ol",
    "li",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "tr",
    "section",
    "article",
    "header",
    "footer",
    "pre",
    "body",
    "html",
    "center",
}
_BR = "\x01"
IMG_TOKEN = "\x02{}\x02"


@dataclasses.dataclass
class _Node:
    tag: str
    attrs: dict
    children: list


class _TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = _Node("root", {}, [])
        self.stack = [self.root]
        self.dropping = 0

    def handle_starttag(self, tag, attrs):
        if self.dropping:
            if tag in _DROP:
                self.dropping += 1
            return
        if tag in _DROP:
            self.dropping = 1
            return
        node = _Node(tag, {k: (v or "") for k, v in attrs}, [])
        self.stack[-1].children.append(node)
        if tag not in _VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        if not self.dropping and tag not in _DROP:
            self.stack[-1].children.append(_Node(tag, {k: (v or "") for k, v in attrs}, []))

    def handle_endtag(self, tag):
        if self.dropping:
            if tag in _DROP:
                self.dropping -= 1
            return
        for i in range(len(self.stack) - 1, 0, -1):
            if self.stack[i].tag == tag:
                del self.stack[i:]
                return

    def handle_data(self, data):
        if not self.dropping:
            self.stack[-1].children.append(data)


def _finish_paragraph(text: str) -> str:
    lines = [re.sub(r"[ \t\r\n\f]+", " ", part).strip() for part in text.split(_BR)]
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return "  \n".join(lines)


def _inline(node) -> str:
    if isinstance(node, str):
        return node
    tag = node.tag
    if tag == "br":
        return _BR
    if tag == "img":
        src = node.attrs.get("src", "")
        return IMG_TOKEN.format(src[4:]) if src.lower().startswith("cid:") else ""
    inner = "".join(_inline(c) for c in node.children)
    if tag in ("strong", "b") and inner.strip():
        return f"**{inner.strip()}**"
    if tag in ("em", "i") and inner.strip():
        return f"*{inner.strip()}*"
    if tag == "a":
        href = node.attrs.get("href", "").strip()
        if re.match(r"(?i)^(https?:|mailto:)", href) and inner.strip():
            return f"[{inner.strip()}]({href})"
    if tag in _BLOCK:
        return _BR + inner + _BR
    return inner


def _blocks(children) -> list[str]:
    blocks, run = [], []

    def flush():
        text = _finish_paragraph("".join(run))
        run.clear()
        if text:
            blocks.append(text)

    for child in children:
        if isinstance(child, _Node) and child.tag in _BLOCK:
            flush()
            blocks.extend(_block(child))
        else:
            run.append(_inline(child))
    flush()
    return blocks


def _block(node: _Node) -> list[str]:
    if node.tag == "blockquote":
        inner = "\n\n".join(_blocks(node.children))
        if not inner:
            return []
        return ["\n".join(("> " + line) if line else ">" for line in inner.split("\n"))]
    if node.tag in ("ul", "ol"):
        items, n = [], 0
        for child in node.children:
            if isinstance(child, _Node) and child.tag == "li":
                n += 1
                marker = f"{n}. " if node.tag == "ol" else "- "
                text = "\n\n".join(_blocks(child.children))
                if not text:
                    continue
                pad = " " * len(marker)
                lines = text.split("\n")
                items.append(
                    marker + lines[0] + "".join("\n" + (pad + ln if ln else "") for ln in lines[1:])
                )
        return ["\n".join(items)] if items else []
    return _blocks(node.children)


def html_to_markdown(html_text: str) -> str:
    """Markdown for paragraphs, line breaks, links, bold/italic, lists and blockquotes.

    Every other element keeps its text and loses its markup; `<img src="cid:...">` becomes an
    IMG_TOKEN placeholder that build_post replaces with the uploaded image.
    """
    builder = _TreeBuilder()
    builder.feed(html_text)
    builder.close()
    return "\n\n".join(_blocks(builder.root.children))


# --------------------------------------------------------------------------
# Message -> post
# --------------------------------------------------------------------------


@dataclasses.dataclass
class Image:
    content_id: str | None
    ext: str
    data: bytes


@dataclasses.dataclass
class ParsedEmail:
    title: str
    body: str  # Markdown, possibly carrying IMG_TOKEN placeholders for inline images
    images: list[Image]
    skipped_attachments: list[str]
    date: datetime.datetime


@dataclasses.dataclass
class Post:
    entry_name: str
    slug: str
    path: str
    files: dict[str, bytes]
    image_paths: list[str]
    skipped_attachments: list[str]
    title: str


def _decode_text(part: email.message.Message) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        text = payload.decode(charset, "replace")
    except LookupError:
        text = payload.decode("utf-8", "replace")
    return text.replace("\r\n", "\n").replace("\r", "\n")


def _strip_signature(text: str) -> str:
    lines = text.split("\n")
    for i in range(len(lines) - 1, -1, -1):
        if lines[i] == "-- ":
            lines = lines[:i]
            break
    return "\n".join(line.rstrip() for line in lines).strip("\n")


def _content_id(part: email.message.Message) -> str | None:
    cid = part.get("Content-ID")
    return str(cid).strip().strip("<>") if cid else None


def parse_email(msg: email.message.Message, date: datetime.datetime) -> ParsedEmail:
    """Title, Markdown body and images of `msg`. Raises ContentError for an unusable email."""
    title = re.sub(r"\s+", " ", str(msg.get("Subject", "") or "")).strip()
    if not title:
        raise ContentError("Add a subject line; it becomes the post title.")

    plain = html = None
    images: list[Image] = []
    skipped: list[str] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disposition = (part.get_content_disposition() or "").lower()
        filename = part.get_filename()
        if ctype in IMAGE_TYPES:
            data = part.get_payload(decode=True) or b""
            images.append(Image(_content_id(part), IMAGE_TYPES[ctype], data))
        elif ctype == "text/plain" and disposition != "attachment" and plain is None:
            plain = _decode_text(part)
        elif ctype == "text/html" and disposition != "attachment" and html is None:
            html = _decode_text(part)
        elif disposition == "attachment" or filename:
            skipped.append(filename or ctype)

    if plain is not None and plain.strip():
        body = _strip_signature(plain)
    elif html is not None:
        body = html_to_markdown(html)
    else:
        body = ""
    if not re.sub("\x02[^\x02]*\x02", "", body).strip():
        raise ContentError("The email has no text; its body becomes the post.")
    if len(images) > MAX_IMAGES:
        raise ContentError(f"Attach at most {MAX_IMAGES} images; this email has {len(images)}.")
    for image in images:
        if len(image.data) > MAX_IMAGE_BYTES:
            raise ContentError("Each image must be 10 MB or smaller; resize the larger ones.")
    return ParsedEmail(title, body, images, skipped, date)


def _front_matter(fields: dict) -> str:
    return yaml.safe_dump(fields, sort_keys=False, allow_unicode=True, width=10_000)


def build_post(parsed: ParsedEmail, tz: datetime.tzinfo, suffix: int = 1) -> Post:
    """The files of the post; `suffix` > 1 appends `-<suffix>` to the slug (name collisions)."""
    base = decap_title_slug(parsed.title)
    if not base:
        raise ContentError(
            "The subject needs at least one letter or digit from A to Z or 0 to 9; "
            "the post's address is made from it."
        )
    slug = base if suffix <= 1 else f"{base}-{suffix}"
    local = parsed.date.astimezone(tz)
    entry_name = f"{local:%Y-%m-%d}-{slug}"
    path = f"_posts/{entry_name}.md"

    files: dict[str, bytes] = {}
    image_paths: list[str] = []
    by_cid: dict[str, str] = {}
    for n, image in enumerate(parsed.images, start=1):
        rel = f"{UPLOAD_DIR}/{slug}-{n}.{image.ext}"
        files[rel] = image.data
        image_paths.append("/" + rel)
        if image.content_id:
            by_cid[image.content_id] = "/" + rel

    body = parsed.body
    placed: set[str] = set()

    def place(match: re.Match) -> str:
        url = by_cid.get(match.group(1))
        if not url:
            return ""
        placed.add(url)
        return f"\n\n![]({url})\n\n"

    body = re.sub("\x02([^\x02]*)\x02", place, body)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    rest = [url for url in image_paths if url not in placed]
    if rest:
        body += "\n\n" + "\n\n".join(f"![]({url})" for url in rest)

    fields = {
        "title": parsed.title,
        "slug": slug,
        "date": local.strftime("%Y-%m-%d %H:%M:%S %z"),
    }
    if image_paths:
        fields["featured_image"] = image_paths[0]
    fields["published"] = True
    fields["test_fixture"] = False
    text = f"---\n{_front_matter(fields)}---\n\n{body}\n"
    files = {path: text.encode("utf-8"), **files}
    return Post(
        entry_name, slug, path, files, image_paths, parsed.skipped_attachments, parsed.title
    )


def admin_link(site_url: str, entry_name: str) -> str:
    return f"{site_url.rstrip('/')}/admin/#/collections/posts/entries/{entry_name}"
