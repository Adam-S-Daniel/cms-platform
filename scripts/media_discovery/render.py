"""Render the content file, PR body and digest email for a confirmed candidate."""

import re
import string
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

import yaml

from .candidate import Candidate, parse_date
from .config import Config
from .corroborate import Verdict
from .dedupe import pr_marker

WORD_JOINER = "⁠"
VALUE_MAX = 300
MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August",
          "September", "October", "November", "December")

# kind -> (collection, media category)
KIND_TARGET = {
    "upcoming_talk": ("events", None),
    "past_talk": ("media", "Talks & Panels"),
    "podcast": ("media", "Podcasts & Interviews"),
    "press": ("media", "Press Coverage"),
    "authored_article": ("media", "Articles & Commentary"),
    "brief_testimony": ("media", "Briefs, Testimony & Reports"),
}


@dataclass(frozen=True)
class Entry:
    collection: str
    slug: str
    path: str
    branch: str
    content: str


def slugify(s: str, max_len: int = 60) -> str:
    folded = unicodedata.normalize("NFKD", s.casefold())
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", folded).strip("-")
    if len(slug) > max_len:
        if slug[max_len] == "-":
            slug = slug[:max_len]
        else:
            cut = slug[:max_len]
            slug = cut[:cut.rfind("-")] if "-" in cut else cut
        slug = slug.strip("-")
    return slug or "item"


def _clean(s, cap: int) -> str:
    """One line, no control or format characters (bidi overrides, zero-width
    joiners, ...), capped. safe_md adds its own word joiners after this runs."""
    out = []
    for ch in str(s or ""):
        cat = unicodedata.category(ch)
        if cat in ("Zl", "Zp") or ch in "\n\r\t":
            out.append(" ")
        elif cat not in ("Cc", "Cf"):
            out.append(ch)
    return " ".join("".join(out).split())[:cap].rstrip()


def _month_year(d) -> str:
    return f"{MONTHS[d.month - 1]} {d.year}"


def _event_display(start, end) -> str:
    if end is None or end <= start:
        return f"{MONTHS[start.month - 1]} {start.day}, {start.year}"
    if (end.year, end.month) == (start.year, start.month):
        return f"{MONTHS[start.month - 1]} {start.day} – {end.day}, {start.year}"
    if end.year == start.year:
        return (f"{MONTHS[start.month - 1]} {start.day} – "
                f"{MONTHS[end.month - 1]} {end.day}, {end.year}")
    return (f"{MONTHS[start.month - 1]} {start.day}, {start.year} – "
            f"{MONTHS[end.month - 1]} {end.day}, {end.year}")


def render_entry(candidate: Candidate, kind: str, cfg: Config) -> Entry:
    collection, category = KIND_TARGET[kind]
    if collection == "events":
        if len(candidate.date) != 10:
            raise ValueError("an event needs a full YYYY-MM-DD date")
        start = parse_date(candidate.date)
        end = parse_date(candidate.end_date) if candidate.end_date else None
        slug = f"{candidate.date}-{slugify(candidate.title)}"
        fields = [
            ("title", _clean(candidate.title, VALUE_MAX)),
            ("org", _clean(candidate.outlet, VALUE_MAX)),
            ("start_date", _clean(candidate.date, VALUE_MAX)),
            ("date_display", _clean(_event_display(start, end), VALUE_MAX)),
            ("location", _clean(candidate.location, VALUE_MAX)),
            ("session", _clean(candidate.session, VALUE_MAX)),
            ("event_url", _clean(candidate.primary_url, 2000)),
        ]
        folder = cfg.collections.events.folder
    else:
        weight = cfg.collections.media.weight
        slug = f"{weight}-{slugify(candidate.title)}"
        fields = [
            ("category", _clean(category, VALUE_MAX)),
            ("title", _clean(candidate.title, VALUE_MAX)),
            ("source", _clean(candidate.outlet, VALUE_MAX)),
            ("date_display", _clean(_month_year(parse_date(candidate.date)), VALUE_MAX)),
            ("article_url", _clean(candidate.primary_url, 2000)),
            ("weight", weight),
        ]
        folder = cfg.collections.media.folder
    # PyYAML does the quoting (including date-looking strings such as start_date).
    body = yaml.safe_dump(dict(fields), sort_keys=False, allow_unicode=True,
                          default_flow_style=False, width=10**9)
    return Entry(collection, slug, f"{folder}/{slug}.md", f"cms/{collection}/{slug}",
                 f"---\n{body}---\n")


ASCII_PUNCTUATION = re.compile("([" + re.escape(string.punctuation) + "])")


def safe_md(s, cap: int = 600) -> str:
    """Encode untrusted web text for a Markdown PR body or email.

    Backslash-escapes every ASCII punctuation character, as CommonMark 0.31.2
    section 2.4 (Backslash escapes) specifies, so no character can start markup,
    HTML or a link. GitHub's mention, issue-reference and autolink processing runs
    on the rendered text and backslashes do not stop it, so a word joiner is
    inserted first (after `@`, after `#` before a digit, after `GH-`, inside `://`);
    the joiner is not ASCII, so the escaping pass leaves it in place."""
    text = _clean(s, cap)
    text = text.replace("@", "@" + WORD_JOINER)
    text = re.sub(r"(#|gh-)(?=\d)", lambda m: m.group(1) + WORD_JOINER, text, flags=re.I)
    text = text.replace("://", ":/" + WORD_JOINER + "/")
    return ASCII_PUNCTUATION.sub(r"\\\1", text)


def _link(url: str) -> str:
    """A URL as a Markdown autolink if it is http(s); otherwise inert text."""
    parts = urlsplit(url.strip())
    if parts.scheme in ("http", "https") and parts.hostname:
        return "<" + quote(url.strip(), safe=":/?#[]@!$&'()*+,;=%-._~") + ">"
    return safe_md(url)


def render_pr(candidate: Candidate, kind: str, entry: Entry, verdict: Verdict,
              admin_url: str) -> tuple[str, str]:
    label = "Media" if entry.collection == "media" else "Events"
    title = f"Create {label} “{entry.slug}”"
    rows = []
    for src in verdict.sources:
        ident = src.identity
        rows.append("| {} | {} | {} | {} |".format(
            _link(src.url), safe_md(src.domain),
            safe_md(ident.marker) if ident and ident.marker else "none",
            safe_md(ident.snippet, 300) if ident and ident.snippet else ""))
    body = "\n".join([
        pr_marker(candidate.primary_url),
        "",
        "## TLDR",
        "",
        f"Found by the weekly media search: {safe_md(candidate.title)}, "
        f"{safe_md(candidate.outlet)}, {safe_md(candidate.date)}. Publish it in /admin to add "
        "it to the site, or delete it there to reject it.",
        "",
        "## Sources",
        "",
        "| URL | Domain | Identity marker | Quote |",
        "| --- | --- | --- | --- |",
        *rows,
        "",
        "## Why the model thinks it is this person",
        "",
        safe_md(candidate.reasoning, 1500),
        "",
        f"Review and publish: {_link(admin_url)}",
    ]) + "\n"
    return title, body


def render_digest(site_name: str, new_prs, unconfirmed, would_open=()) -> tuple[str, str] | None:
    """The run's email. `new_prs` is (pr title, PR URL, admin URL) per opened PR;
    `would_open` is (candidate, entry) per confirmed find in email-only mode;
    `unconfirmed` is (candidate, reasons)."""
    if not new_prs and not would_open and not unconfirmed:
        return None
    site = _clean(site_name, 100)
    if new_prs:
        n = len(new_prs)
        subject = f"{n} new {'find' if n == 1 else 'finds'} for {site} to review"
    elif would_open:
        n = len(would_open)
        subject = f"{n} confirmed {'find' if n == 1 else 'finds'} for {site} (email-only mode)"
    else:
        n = len(unconfirmed)
        subject = f"{n} unconfirmed {'find' if n == 1 else 'finds'} for {site}"
    lines = []
    if new_prs:
        lines += ["New finds to review:", ""]
        for title, pr_url, admin_url in new_prs:
            lines += [f"- {_clean(title, 200)}", f"  Pull request: {_clean(pr_url, 500)}",
                      f"  Admin: {_clean(admin_url, 500)}"]
        lines.append("")
    if would_open:
        lines += ["Confirmed, and would open a pull request in live mode (email-only mode "
                  "is on, so none was opened):", ""]
        for cand, entry in would_open:
            lines += [f"- {_clean(cand.title, 200)} ({_clean(cand.outlet, 100)}, "
                      f"{_clean(cand.date, 10)})", f"  {_clean(cand.primary_url, 500)}",
                      f"  Would add: {_clean(entry.path, 200)}"]
        lines.append("")
    if unconfirmed:
        lines += ["Found but not confirmed (no pull request was opened):", ""]
        for cand, reasons in unconfirmed:
            lines += [f"- {_clean(cand.title, 200)} ({_clean(cand.outlet, 100)}, "
                      f"{_clean(cand.date, 10)})", f"  {_clean(cand.primary_url, 500)}"]
            lines += [f"  Why not: {_clean(r, 300)}" for r in reasons]
        lines.append("")
    return subject, "\n".join(lines)
