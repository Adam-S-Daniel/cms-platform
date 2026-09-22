#!/usr/bin/env python3
"""Cross-post newly published blog posts to Mastodon, LinkedIn and Substack.

Pure-ish module (stdlib + PyYAML only) that:

  * detects which `_posts/*.md` files were *newly* published between two
    git shas (or were given explicitly via ``--post``),
  * renders a Mastodon status and a Substack-ready Markdown body for each,
  * verifies the post is live at its public URL,
  * posts the status to Mastodon (idempotently, skipping duplicates),
  * shares the post to the token owner's LinkedIn profile as an article card
    (one-shot: LinkedIn has no dedupe, so a failure is never retried), and
  * checks the LinkedIn token's age for a weekly scheduled run,

via a small CLI (``python3 scripts/cross_post/cross_post.py <subcommand>``).

No network calls happen anywhere except inside the real ``urllib_transport``
/ ``linkedin_transport`` / CLI ``fetch`` functions -- every function that
talks HTTP takes an injectable callable so tests can supply a fake.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import yaml

# --------------------------------------------------------------------------
# Lexical tokens (fences, embed markers, link syntax) -- regex is fine here,
# front matter / config YAML itself is always parsed with yaml.safe_load.
# --------------------------------------------------------------------------

_FRONT_MATTER_RE = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.DOTALL)
_FILENAME_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})-(.+)\.md$")
_EMBED_RE = re.compile(
    r"<!--\s*html-embed:start\s*-->.*?<!--\s*html-embed:end\s*-->", re.DOTALL
)
_MD_LINK_RE = re.compile(r"(\]\()(/(?!/)[^)]*)(\))")
_HTML_ATTR_RE = re.compile(r'\b(src|href)="(/(?!/)[^"]*)"')
_PLACEHOLDER_RE = re.compile(r":(\w+)")
_WS_RE = re.compile(r"\s+")


# --------------------------------------------------------------------------
# 1. parse_post
# --------------------------------------------------------------------------


def parse_post(text: str) -> tuple[dict, str]:
    """Split `text` into (front-matter dict, body). Missing front matter -> ({}, text)."""
    match = _FRONT_MATTER_RE.match(text)
    if not match:
        return {}, text
    meta = yaml.safe_load(match.group(1))
    if meta is None:
        meta = {}
    body = text[match.end() :]
    return meta, body


# --------------------------------------------------------------------------
# 2. slugify / slug_for
# --------------------------------------------------------------------------


def slugify(name: str) -> str:
    """Jekyll-style slugify: lowercase; non letter/digit/mark runs -> '-'; trim edges."""
    chars = []
    for ch in name:
        category = unicodedata.category(ch)
        if category[0] in ("L", "N", "M"):
            chars.append(ch.lower())
        else:
            chars.append("-")
    collapsed = re.sub(r"-+", "-", "".join(chars))
    return collapsed.strip("-")


def slug_for(path: str, meta: dict) -> str:
    """Front-matter `slug` wins; else slugify the filename minus date prefix/suffix."""
    fm_slug = meta.get("slug")
    if fm_slug:
        return str(fm_slug)
    basename = Path(path).name
    match = _FILENAME_RE.match(basename)
    name = match.group(2) if match else re.sub(r"\.md$", "", basename)
    return slugify(name)


# --------------------------------------------------------------------------
# 3. site_settings / post_url
# --------------------------------------------------------------------------


@dataclasses.dataclass
class SiteSettings:
    url: str
    permalink: str


def site_settings(config_text: str) -> SiteSettings:
    data = yaml.safe_load(config_text) or {}
    return SiteSettings(url=str(data.get("url", "")), permalink=str(data.get("permalink", "")))


def post_url(settings: SiteSettings, slug: str) -> str:
    placeholders = _PLACEHOLDER_RE.findall(settings.permalink)
    if placeholders != ["slug"]:
        raise SystemExit(
            "cross_post: unsupported permalink pattern "
            f"{settings.permalink!r} -- only a single ':slug' placeholder is supported"
        )
    path = _PLACEHOLDER_RE.sub(slug, settings.permalink)
    return settings.url.rstrip("/") + path


# --------------------------------------------------------------------------
# 4. is_fixture / is_published
# --------------------------------------------------------------------------


def is_published(meta: dict) -> bool:
    """`published` absent means published (Jekyll default)."""
    return bool(meta.get("published", True))


def is_fixture(meta: dict, slug: str) -> bool:
    """Same discriminator the site uses everywhere: test_fixture truthy or an e2e- slug."""
    return bool(meta.get("test_fixture")) or slug.startswith("e2e-")


# --------------------------------------------------------------------------
# 5. newly_published
# --------------------------------------------------------------------------


def newly_published(before: str | None, after: str | None, path: str) -> bool:
    if after is None:
        return False
    after_meta, _ = parse_post(after)
    after_slug = slug_for(path, after_meta)
    if not is_published(after_meta) or is_fixture(after_meta, after_slug):
        return False
    if before is None:
        return True
    before_meta, _ = parse_post(before)
    return not is_published(before_meta)


# --------------------------------------------------------------------------
# 6. detect_from_git
# --------------------------------------------------------------------------


def _git_show(run, sha: str, path: str) -> str | None:
    result = run(["git", "show", f"{sha}:{path}"], capture_output=True, text=True)
    if getattr(result, "returncode", 0) != 0:
        return None
    return result.stdout


def detect_from_git(before_sha, after_sha, run=subprocess.run) -> list[str]:
    if not before_sha or set(before_sha) == {"0"}:
        return []

    result = run(
        [
            "git",
            "diff",
            "--name-status",
            "--no-renames",
            "--diff-filter=AM",
            before_sha,
            after_sha,
            "--",
            "_posts/",
        ],
        capture_output=True,
        text=True,
    )

    newly: list[str] = []
    for line in result.stdout.splitlines():
        line = line.strip("\n")
        if not line.strip():
            continue
        status, _, path = line.partition("\t")
        status = status.strip()
        after_text = _git_show(run, after_sha, path)
        before_text = None if status == "A" else _git_show(run, before_sha, path)
        if newly_published(before_text, after_text, path):
            newly.append(path)
    return newly


# --------------------------------------------------------------------------
# 7. describe_post
# --------------------------------------------------------------------------


def _collapse_ws(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _first_paragraph(body: str) -> str:
    text = _EMBED_RE.sub("", body)
    for para in re.split(r"\n\s*\n", text.strip()):
        para = para.strip()
        if not para or para.startswith("#"):
            continue
        return _collapse_ws(para)
    return ""


def _excerpt_for(meta: dict, body: str) -> str:
    excerpt = meta.get("excerpt")
    if excerpt:
        return _collapse_ws(str(excerpt))
    description = meta.get("description")
    if description:
        return _collapse_ws(str(description))
    return _first_paragraph(body)


def describe_post(path: str, text: str, settings: SiteSettings) -> dict:
    meta, body = parse_post(text)
    slug = slug_for(path, meta)
    url = post_url(settings, slug)
    date = meta.get("date")
    date_str = "" if date in (None, "") else str(date)
    tags = [str(tag) for tag in (meta.get("tags") or [])]
    featured_image = meta.get("featured_image") or ""
    if featured_image.startswith("/") and not featured_image.startswith("//"):
        featured_image = settings.url.rstrip("/") + featured_image
    return {
        "path": path,
        "slug": slug,
        "title": str(meta.get("title", "")),
        "url": url,
        "date": date_str,
        "excerpt": _excerpt_for(meta, body),
        "tags": tags,
        "featured_image": featured_image,
    }


# --------------------------------------------------------------------------
# 8. mastodon_status
# --------------------------------------------------------------------------


def _hashtag(tag: str) -> str:
    parts = [p.capitalize() for p in re.split(r"[^0-9A-Za-z]+", tag) if p]
    if not parts:
        return ""
    return "#" + "".join(parts)


def _hashtags(tags: list[str]) -> list[str]:
    seen: list[str] = []
    for tag in tags:
        h = _hashtag(tag)
        if h and h not in seen:
            seen.append(h)
    return seen


def mastodon_status(post: dict, max_chars: int = 500) -> str:
    title = post.get("title", "")
    url = post.get("url", "")
    excerpt = post.get("excerpt") or ""
    hashtag_line = " ".join(_hashtags(post.get("tags") or []))

    def build(excerpt_text: str, include_hashtags: bool) -> str:
        parts = [title]
        if excerpt_text:
            parts.append(excerpt_text)
        parts.append(url)
        if include_hashtags and hashtag_line:
            parts.append(hashtag_line)
        return "\n\n".join(parts)

    current = excerpt
    status = build(current, True)
    while len(status) > max_chars and current:
        stripped = current[:-1].rstrip() if current.endswith("…") else current
        words = stripped.split(" ")
        current = "" if len(words) <= 1 else " ".join(words[:-1]) + "…"
        status = build(current, True)

    if len(status) > max_chars:
        status = build("", False)

    return status


# --------------------------------------------------------------------------
# 9. substack_markdown
# --------------------------------------------------------------------------


def _strip_blank_edges(text: str) -> str:
    lines = text.split("\n")
    while lines and lines[0].strip() == "":
        lines.pop(0)
    while lines and lines[-1].strip() == "":
        lines.pop()
    return "\n".join(lines)


def substack_markdown(post: dict, body: str) -> str:
    url = post.get("url", "")
    parsed = urlparse(url)
    host = parsed.netloc
    site_root = f"{parsed.scheme}://{host}" if parsed.scheme else host
    header = f"*Originally published at [{host}]({url}).*"

    embed_replacement = f"*[Interactive version of this section on {host}]({url})*"
    transformed = _EMBED_RE.sub(lambda m: embed_replacement, body)
    transformed = _MD_LINK_RE.sub(lambda m: m.group(1) + site_root + m.group(2) + m.group(3), transformed)
    transformed = _HTML_ATTR_RE.sub(
        lambda m: f'{m.group(1)}="{site_root}{m.group(2)}"', transformed
    )
    transformed = _strip_blank_edges(transformed)

    return f"{header}\n\n{transformed}\n"


# --------------------------------------------------------------------------
# 10. render
# --------------------------------------------------------------------------


def _post_meta_dict(post: dict) -> dict:
    return {
        "title": post.get("title", ""),
        "subtitle": post.get("excerpt", ""),
        "url": post.get("url", ""),
        "slug": post.get("slug", ""),
        "date": post.get("date", ""),
        "tags": post.get("tags", []),
        "featured_image": post.get("featured_image", ""),
    }


def render(posts, out_dir, read_body, max_chars, summary_path=None) -> None:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    summary_chunks: list[str] = []

    for post in posts:
        slug = post["slug"]
        body = read_body(post)
        status = mastodon_status(post, max_chars=max_chars)
        substack = substack_markdown(post, body)
        meta = _post_meta_dict(post)

        (out_dir / f"{slug}.status.txt").write_text(status, encoding="utf-8")
        (out_dir / f"{slug}.substack.md").write_text(substack, encoding="utf-8")
        (out_dir / f"{slug}.meta.json").write_text(
            json.dumps(meta, indent=2) + "\n", encoding="utf-8"
        )

        if summary_path:
            lines = [f"## {post.get('title', '')}", "", "**Mastodon status**", "", "```"]
            lines.append(status)
            lines.append("```")
            lines.append("")
            lines.append("**Meta**")
            lines.append("")
            for key, value in meta.items():
                lines.append(f"- {key}: {value}")
            lines.append("")
            lines.append("<details><summary>Substack Markdown</summary>")
            lines.append("")
            lines.append("```markdown")
            lines.append(substack)
            lines.append("```")
            lines.append("")
            lines.append("</details>")
            lines.append("")
            summary_chunks.append("\n".join(lines))

    if summary_path and summary_chunks:
        with open(summary_path, "a", encoding="utf-8") as handle:
            handle.write("\n" + "\n\n".join(summary_chunks) + "\n")


# --------------------------------------------------------------------------
# 11. verify_live
# --------------------------------------------------------------------------


def verify_live(urls, fetch, attempts: int = 20, sleep=lambda s: None) -> list[str]:
    pending = list(dict.fromkeys(urls))
    for attempt in range(attempts):
        pending = [url for url in pending if fetch(url) != 200]
        if not pending:
            break
        if attempt < attempts - 1:
            sleep(15)
    return pending


# --------------------------------------------------------------------------
# 12. post_mastodon
# --------------------------------------------------------------------------


def urllib_transport(method: str, url: str, headers: dict, data: bytes | None):
    """Real HTTP transport -- the only place in the module that touches the network."""
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as err:
        return err.code, err.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, b""


def _resolve_account_id(instance: str, headers: dict, transport) -> str:
    status_code, body = transport(
        "GET", f"{instance}/api/v1/accounts/verify_credentials", headers, None
    )
    if status_code != 200:
        print(f"::error::Mastodon account lookup failed: HTTP {status_code}")
        raise SystemExit(1)
    data = json.loads(body.decode("utf-8"))
    return data["id"]


def _find_existing_status(instance: str, headers: dict, transport, account_id: str, post_url_value: str):
    url = (
        f"{instance}/api/v1/accounts/{account_id}/statuses"
        "?limit=40&exclude_replies=true&exclude_reblogs=true"
    )
    status_code, body = transport("GET", url, headers, None)
    if status_code in (401, 403):
        print(
            f"::error::Mastodon dedupe lookup refused (HTTP {status_code}): the token needs "
            "the read:statuses scope (profile + read:statuses + write:statuses; see "
            'docs/CROSS-POSTING.md "Creating the Mastodon app token"); not posting without a '
            "duplicate check"
        )
        raise SystemExit(1)
    if status_code != 200:
        print(
            f"::warning::Mastodon dedupe lookup failed (HTTP {status_code}); "
            "posting without a duplicate check"
        )
        return None
    needle = f'href="{post_url_value}"'
    for status in json.loads(body.decode("utf-8")):
        if needle in status.get("content", ""):
            return status.get("url")
    return None


def post_mastodon(
    posts,
    instance: str,
    token: str | None,
    transport,
    visibility: str = "public",
    dry_run: bool = False,
    out_dir=None,
) -> list[dict]:
    if not token:
        print("::warning::Mastodon leg skipped: MASTODON_ACCESS_TOKEN is not set")
        return [{"slug": post["slug"], "skipped": "no-token"} for post in posts]

    auth_headers = {"Authorization": f"Bearer {token}"}
    account_id = _resolve_account_id(instance, auth_headers, transport)

    results: list[dict] = []
    failed_slugs: list[str] = []

    for post in posts:
        slug = post["slug"]
        existing_url = _find_existing_status(instance, auth_headers, transport, account_id, post["url"])
        if existing_url is not None:
            results.append({"slug": slug, "skipped": "already-posted", "existing_url": existing_url})
            continue

        status_text = mastodon_status(post)

        if dry_run:
            print(f"::group::Mastodon status (dry run) for {slug}")
            print(status_text)
            print("::endgroup::")
            results.append({"slug": slug, "dry_run": True})
            continue

        payload = json.dumps(
            {"status": status_text, "visibility": visibility, "language": "en"}
        ).encode("utf-8")
        idempotency_key = hashlib.sha256(post["url"].encode("utf-8")).hexdigest()[:32]
        headers = {
            "Authorization": f"Bearer {token}",
            "Idempotency-Key": idempotency_key,
            "Content-Type": "application/json",
        }
        status_code, body = transport("POST", f"{instance}/api/v1/statuses", headers, payload)

        if status_code in (200, 201, 202):
            data = json.loads(body.decode("utf-8"))
            print(f"Posted: {data.get('url')}")
            result = {"slug": slug, "url": data.get("url"), "id": data.get("id")}
            if out_dir:
                out_path = Path(out_dir)
                out_path.mkdir(parents=True, exist_ok=True)
                (out_path / f"{slug}.mastodon.json").write_text(
                    json.dumps(data, indent=2) + "\n", encoding="utf-8"
                )
            results.append(result)
        else:
            print(f"::error::Mastodon POST failed for {slug}: HTTP {status_code}")
            failed_slugs.append(slug)
            results.append({"slug": slug, "error": status_code})

    if failed_slugs:
        raise SystemExit(1)

    return results


# --------------------------------------------------------------------------
# 13. LinkedIn: commentary, token age, post_linkedin
# --------------------------------------------------------------------------

# LinkedIn's versioned REST API (YYYYMM). A sunset version answers HTTP 426;
# bump this constant when that happens.
LINKEDIN_API_VERSION = "202609"
LINKEDIN_API = "https://api.linkedin.com"
# A member access token from LinkedIn's 3-legged OAuth flow lives 60 days and
# cannot be refreshed without re-consent, so the weekly check goes red at 50.
LINKEDIN_TOKEN_WARN_DAYS = 50
LINKEDIN_TOKEN_LIFETIME_DAYS = 60

_LITTLE_TEXT_RESERVED = "\\|{}@[]()<>#*_~"
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_ROTATE_HINT = 'rotate it — see docs/CROSS-POSTING.md "Rotating the LinkedIn token"'


def little_text_escape(text: str) -> str:
    """Backslash-escape every LinkedIn "little text" reserved character.

    Iterating per character escapes the backslash itself exactly once, before
    any escape this function introduces could be re-escaped.
    """
    return "".join("\\" + ch if ch in _LITTLE_TEXT_RESERVED else ch for ch in text)


def linkedin_hashtag(tag: str) -> str:
    """`{hashtag|\\#|Word}` little-text hashtag template, or "" for a tag with no alphanumerics."""
    plain = _hashtag(tag)
    if not plain:
        return ""
    return "{hashtag|\\#|" + plain[1:] + "}"


def _linkedin_hashtags(tags: list[str]) -> list[str]:
    seen: list[str] = []
    for tag in tags:
        h = linkedin_hashtag(tag)
        if h and h not in seen:
            seen.append(h)
    return seen


def linkedin_commentary(post: dict, max_chars: int = 2900) -> str:
    """Title, excerpt and hashtags as escaped little text; no URL (the article card carries it)."""
    title = little_text_escape(post.get("title", ""))
    excerpt = post.get("excerpt") or ""
    hashtag_line = " ".join(_linkedin_hashtags(post.get("tags") or []))

    def build(excerpt_text: str, include_hashtags: bool) -> str:
        parts = [title]
        if excerpt_text:
            parts.append(little_text_escape(excerpt_text))
        if include_hashtags and hashtag_line:
            parts.append(hashtag_line)
        return "\n\n".join(parts)

    current = excerpt
    commentary = build(current, True)
    while len(commentary) > max_chars and current:
        stripped = current[:-1].rstrip() if current.endswith("…") else current
        words = stripped.split(" ")
        current = "" if len(words) <= 1 else " ".join(words[:-1]) + "…"
        commentary = build(current, True)

    if len(commentary) > max_chars:
        commentary = build("", False)

    return commentary


def linkedin_token_age(minted, today: datetime.date) -> int | None:
    """Days since `minted` (YYYY-MM-DD); None when it is empty or unparseable."""
    text = str(minted or "").strip()
    if not _ISO_DATE_RE.match(text):
        return None
    try:
        minted_date = datetime.datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        return None
    return (today - minted_date).days


def _token_expired_message(minted: str, age: int) -> str:
    return f"::error::LinkedIn access token expired (minted {minted}, {age} days ago); {_ROTATE_HINT}"


def _token_expiring_message(level: str, minted: str, age: int) -> str:
    remaining = LINKEDIN_TOKEN_LIFETIME_DAYS - age
    return (
        f"::{level}::LinkedIn access token expires in {remaining} day(s) "
        f"(minted {minted}); {_ROTATE_HINT}"
    )


def check_linkedin_token(minted, today: datetime.date) -> int:
    """Weekly token-age check. Red from day 50 on purpose, so scheduled-run-health files an issue."""
    age = linkedin_token_age(minted, today)
    if age is None:
        print(
            "::error::LINKEDIN_TOKEN_MINTED is not set (or not YYYY-MM-DD); set it to the date "
            "the LinkedIn token was minted — "
            'see docs/CROSS-POSTING.md "Rotating the LinkedIn token"'
        )
        return 1
    minted = str(minted).strip()
    if age >= LINKEDIN_TOKEN_LIFETIME_DAYS:
        print(_token_expired_message(minted, age))
        return 1
    if age >= LINKEDIN_TOKEN_WARN_DAYS:
        print(_token_expiring_message("error", minted, age))
        return 1
    remaining = LINKEDIN_TOKEN_LIFETIME_DAYS - age
    print(f"::notice::LinkedIn access token is {age} days old; expires in {remaining} days")
    return 0


def linkedin_transport(method: str, url: str, headers: dict, data: bytes | None):
    """Real HTTP transport for the LinkedIn leg: (status, lowercased headers, body)."""
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            resp_headers = {k.lower(): v for k, v in response.headers.items()}
            return response.status, resp_headers, response.read()
    except urllib.error.HTTPError as err:
        resp_headers = {k.lower(): v for k, v in (err.headers or {}).items()}
        return err.code, resp_headers, err.read()
    except (urllib.error.URLError, TimeoutError, OSError):
        return 0, {}, b""


def _linkedin_rest_headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "LinkedIn-Version": LINKEDIN_API_VERSION,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json",
    }


def _linkedin_rejected_token() -> None:
    print(f"::error::LinkedIn token rejected (HTTP 401): expired or revoked; {_ROTATE_HINT}")


def _resolve_linkedin_author(token: str, transport) -> str:
    status_code, _, body = transport(
        "GET", f"{LINKEDIN_API}/v2/userinfo", {"Authorization": f"Bearer {token}"}, None
    )
    if status_code == 401:
        _linkedin_rejected_token()
        raise SystemExit(1)
    if status_code != 200:
        print(f"::error::LinkedIn userinfo lookup failed: HTTP {status_code}")
        raise SystemExit(1)
    try:
        sub = json.loads(body.decode("utf-8")).get("sub")
    except (ValueError, AttributeError):
        sub = None
    if not sub:
        print("::error::LinkedIn userinfo lookup failed: HTTP 200 without a member id")
        raise SystemExit(1)
    return f"urn:li:person:{sub}"


def _is_linkedin_https_url(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and (host == "linkedin.com" or host.endswith(".linkedin.com"))


def _upload_linkedin_thumbnail(image_url: str, author: str, token: str, transport, slug: str):
    """Upload the featured image; return its image URN, or None (with a warning) on any failure."""

    def skipped(reason: str):
        print(f"::warning::LinkedIn thumbnail upload skipped for {slug}: {reason}")
        return None

    if urlparse(image_url).scheme not in ("http", "https"):
        return skipped("featured_image is not an http(s) URL")

    status_code, _, image_bytes = transport("GET", image_url, {}, None)
    if status_code != 200:
        return skipped(f"HTTP {status_code}")

    payload = json.dumps({"initializeUploadRequest": {"owner": author}}).encode("utf-8")
    status_code, _, body = transport(
        "POST",
        f"{LINKEDIN_API}/rest/images?action=initializeUpload",
        _linkedin_rest_headers(token),
        payload,
    )
    if status_code != 200:
        return skipped(f"HTTP {status_code}")
    try:
        value = json.loads(body.decode("utf-8")).get("value") or {}
        upload_url = value.get("uploadUrl") or ""
        image_urn = value.get("image") or ""
    except (ValueError, AttributeError):
        upload_url = image_urn = ""
    if not upload_url or not image_urn:
        return skipped(f"HTTP {status_code} without an uploadUrl/image")
    if not _is_linkedin_https_url(upload_url):
        # The upload PUT carries the bearer token: never send it off LinkedIn.
        return skipped(f"HTTP {status_code} with an upload URL outside https://*.linkedin.com")

    status_code, _, _ = transport(
        "PUT",
        upload_url,
        {"Authorization": f"Bearer {token}", "Content-Type": "application/octet-stream"},
        image_bytes,
    )
    if status_code not in (200, 201):
        return skipped(f"HTTP {status_code}")
    return image_urn


def _report_linkedin_post_error(slug: str, status_code: int) -> None:
    if status_code == 401:
        _linkedin_rejected_token()
    elif status_code == 426:
        print(
            f"::error::LinkedIn rejected LinkedIn-Version {LINKEDIN_API_VERSION} (HTTP 426): "
            "the API version is sunset; bump LINKEDIN_API_VERSION in cross_post.py"
        )
    elif status_code == 0 or status_code >= 500:
        print(
            f"::error::LinkedIn POST for {slug} returned HTTP {status_code}; it MAY have posted. "
            "Check the profile before re-dispatching with targets=linkedin"
        )
    else:
        print(f"::error::LinkedIn POST failed for {slug}: HTTP {status_code}")


def post_linkedin(
    posts,
    token: str | None,
    transport,
    minted: str = "",
    today: datetime.date | None = None,
    dry_run: bool = False,
    out_dir=None,
) -> list[dict]:
    """Share each post to the token owner's profile as an article. Never retried: no dedupe exists."""
    if not token:
        print("::warning::LinkedIn leg skipped: LINKEDIN_ACCESS_TOKEN is not set")
        return [{"slug": post["slug"], "skipped": "no-token"} for post in posts]

    if today is not None:
        age = linkedin_token_age(minted, today)
        if age is None:
            print("::warning::LINKEDIN_TOKEN_MINTED is not set; cannot warn before the token expires")
        elif age >= LINKEDIN_TOKEN_LIFETIME_DAYS:
            print(_token_expired_message(str(minted).strip(), age))
            raise SystemExit(1)
        elif age >= LINKEDIN_TOKEN_WARN_DAYS:
            print(_token_expiring_message("warning", str(minted).strip(), age))

    author = _resolve_linkedin_author(token, transport)

    results: list[dict] = []
    failed_slugs: list[str] = []

    for post in posts:
        slug = post["slug"]
        commentary = linkedin_commentary(post)
        article = {
            "source": post["url"],
            "title": str(post.get("title", ""))[:400],
            "description": str(post.get("excerpt") or "")[:4000],
        }

        if dry_run:
            print(f"::group::LinkedIn post (dry run) for {slug}")
            print(commentary)
            print(f"article: {json.dumps(article)}")
            print("::endgroup::")
            results.append({"slug": slug, "dry_run": True})
            continue

        image_url = post.get("featured_image") or ""
        if image_url:
            image_urn = _upload_linkedin_thumbnail(image_url, author, token, transport, slug)
            if image_urn:
                article["thumbnail"] = image_urn

        payload = json.dumps(
            {
                "author": author,
                "commentary": commentary,
                "visibility": "PUBLIC",
                "distribution": {
                    "feedDistribution": "MAIN_FEED",
                    "targetEntities": [],
                    "thirdPartyDistributionChannels": [],
                },
                "content": {"article": article},
                "lifecycleState": "PUBLISHED",
                "isReshareDisabledByAuthor": False,
            }
        ).encode("utf-8")
        status_code, headers, _ = transport(
            "POST", f"{LINKEDIN_API}/rest/posts", _linkedin_rest_headers(token), payload
        )

        if status_code == 201:
            urn = headers.get("x-restli-id", "")
            if not urn:
                print(f"::warning::LinkedIn POST for {slug} returned HTTP 201 without x-restli-id")
            url = f"https://www.linkedin.com/feed/update/{urn}/"
            print(f"Posted: {url}")
            if out_dir:
                out_path = Path(out_dir)
                out_path.mkdir(parents=True, exist_ok=True)
                (out_path / f"{slug}.linkedin.json").write_text(
                    json.dumps({"urn": urn, "url": url}, indent=2) + "\n", encoding="utf-8"
                )
            results.append({"slug": slug, "urn": urn, "url": url})
        else:
            _report_linkedin_post_error(slug, status_code)
            failed_slugs.append(slug)
            results.append({"slug": slug, "error": status_code})

    if failed_slugs:
        raise SystemExit(1)

    return results


# --------------------------------------------------------------------------
# 14. CLI
# --------------------------------------------------------------------------


def _write_github_output(pairs: dict) -> None:
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as handle:
        for key, value in pairs.items():
            handle.write(f"{key}={value}\n")


def _read_config() -> SiteSettings:
    return site_settings(Path("_config.yml").read_text(encoding="utf-8"))


def _cmd_detect(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post detect")
    parser.add_argument("--before")
    parser.add_argument("--after")
    parser.add_argument("--post", action="append", default=[])
    parser.add_argument("--out", default="cross-post-out")
    ns = parser.parse_args(argv)

    settings = _read_config()
    posts: list[dict] = []

    if ns.post:
        for post_path in ns.post:
            text = Path(post_path).read_text(encoding="utf-8")
            meta, _ = parse_post(text)
            slug = slug_for(post_path, meta)
            if is_published(meta) and not is_fixture(meta, slug):
                posts.append(describe_post(post_path, text, settings))
    else:
        for post_path in detect_from_git(ns.before, ns.after):
            text = Path(post_path).read_text(encoding="utf-8")
            posts.append(describe_post(post_path, text, settings))

    out_dir = Path(ns.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "posts.json").write_text(json.dumps(posts, indent=2) + "\n", encoding="utf-8")

    for post in posts:
        print(post["slug"])

    _write_github_output({"changed": "true" if posts else "false", "count": len(posts)})
    return 0


def _cmd_render(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post render")
    parser.add_argument("--max-chars", type=int, default=500)
    parser.add_argument("--out", default="cross-post-out")
    ns = parser.parse_args(argv)

    out_dir = Path(ns.out)
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))

    def read_body(post: dict) -> str:
        text = Path(post["path"]).read_text(encoding="utf-8")
        _, body = parse_post(text)
        return body

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    render(posts, out_dir, read_body, ns.max_chars, summary_path=summary_path)
    return 0


def _fetch_head_then_get(url: str) -> int:
    for method in ("HEAD", "GET"):
        try:
            request = urllib.request.Request(url, method=method)
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status
        except urllib.error.HTTPError as err:
            if method == "HEAD":
                continue
            return err.code
        except urllib.error.URLError:
            if method == "HEAD":
                continue
            return 0
    return 0


def _cmd_verify_live(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post verify-live")
    parser.add_argument("--attempts", type=int, default=20)
    parser.add_argument("--out", default="cross-post-out")
    ns = parser.parse_args(argv)

    out_dir = Path(ns.out)
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))
    urls = [post["url"] for post in posts]

    failed = verify_live(urls, _fetch_head_then_get, attempts=ns.attempts, sleep=time.sleep)
    if failed:
        print("::error::These URLs never served 200: " + ", ".join(failed))
        return 1
    return 0


def _cmd_post_mastodon(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post post-mastodon")
    parser.add_argument("--instance", required=True)
    parser.add_argument("--visibility", default="public")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out", default="cross-post-out")
    ns = parser.parse_args(argv)

    out_dir = Path(ns.out)
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))
    token = os.environ.get("MASTODON_ACCESS_TOKEN", "")

    post_mastodon(
        posts,
        ns.instance,
        token,
        urllib_transport,
        visibility=ns.visibility,
        dry_run=ns.dry_run,
        out_dir=out_dir,
    )
    return 0


def _utc_today() -> datetime.date:
    return datetime.datetime.now(datetime.timezone.utc).date()


def _cmd_post_linkedin(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post post-linkedin")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out", default="cross-post-out")
    ns = parser.parse_args(argv)

    out_dir = Path(ns.out)
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))

    post_linkedin(
        posts,
        os.environ.get("LINKEDIN_ACCESS_TOKEN", ""),
        linkedin_transport,
        minted=os.environ.get("LINKEDIN_TOKEN_MINTED", ""),
        today=_utc_today(),
        dry_run=ns.dry_run,
        out_dir=out_dir,
    )
    return 0


def _cmd_check_linkedin_token(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="cross_post check-linkedin-token")
    parser.add_argument(
        "--today",
        type=datetime.date.fromisoformat,
        default=None,
        help="YYYY-MM-DD to measure the age against (default: today, UTC)",
    )
    ns = parser.parse_args(argv)
    today = ns.today if ns.today is not None else _utc_today()
    return check_linkedin_token(os.environ.get("LINKEDIN_TOKEN_MINTED", ""), today)


_SUBCOMMANDS = {
    "detect": _cmd_detect,
    "render": _cmd_render,
    "verify-live": _cmd_verify_live,
    "post-mastodon": _cmd_post_mastodon,
    "post-linkedin": _cmd_post_linkedin,
    "check-linkedin-token": _cmd_check_linkedin_token,
}


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in _SUBCOMMANDS:
        available = ", ".join(_SUBCOMMANDS)
        print(f"usage: cross_post.py <{available}> ...", file=sys.stderr)
        return 2
    return _SUBCOMMANDS[argv[0]](argv[1:])


if __name__ == "__main__":
    sys.exit(main())
