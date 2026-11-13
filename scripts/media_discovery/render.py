"""Render the content file, PR body and digest email for a confirmed candidate."""

import re
import string
import unicodedata
from dataclasses import dataclass
from urllib.parse import quote, urlsplit

import yaml

from .candidate import Candidate, parse_date
from .config import Config
from .corroborate import Problem, Verdict
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


class _DoubleQuoted(str):
    """A string value that must be emitted double-quoted."""


class _FrontMatterDumper(yaml.SafeDumper):
    pass


_FrontMatterDumper.add_representer(
    _DoubleQuoted,
    lambda dumper, data: dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style='"'))


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
    # Every string VALUE is double-quoted so YAML 1.1 (Jekyll) and 1.2 (Decap) loaders
    # keep text such as 1,000 or 1e5 as text; keys stay plain.
    values = {k: _DoubleQuoted(v) if isinstance(v, str) else v for k, v in fields}
    body = yaml.dump(values, Dumper=_FrontMatterDumper, sort_keys=False, allow_unicode=True,
                     default_flow_style=False, width=10**9)
    return Entry(collection, slug, f"{folder}/{slug}.md", f"cms/{collection}/{slug}",
                 f"---\n{body}---\n")


ASCII_PUNCTUATION = re.compile("([" + re.escape(string.punctuation) + "])")


def safe_md(s, cap: int = 600) -> str:
    """Encode untrusted web text for a Markdown PR body.

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


RULE = "━" * 30


def _plain_url(url: str) -> str:
    """A URL for a plain-text email: http(s) only, percent-encoded so no space or
    control character can split it. It always goes on a line of its own, since
    mail clients take punctuation right after a URL (a colon) as part of it."""
    parts = urlsplit(str(url or "").strip())
    if parts.scheme in ("http", "https") and parts.hostname:
        return quote(str(url).strip(), safe=":/?#[]@!$&'()*+,;=%-._~")
    return "(link not shown: not a web address)"


def _when(cand: Candidate) -> str:
    try:
        start = parse_date(cand.date)
        if len(cand.date) != 10:
            return _month_year(start)
        end = parse_date(cand.end_date) if cand.end_date and len(cand.end_date) == 10 else None
        return _event_display(start, end)
    except ValueError:
        return _clean(cand.date, 20)


def _heading(cand: Candidate) -> list[str]:
    return [_clean(cand.title, 200), f"{_clean(cand.outlet, 100)} · {_when(cand)}", "",
            _plain_url(cand.primary_url)]


def _problem_text(problem: Problem, person: str) -> str | None:
    code, detail = problem.code, problem.detail
    if code == "unreadable-type":
        return "is a file (such as a PDF) the search can't read yet."
    if code == "http-status":
        return ("couldn't be reached." if detail == "0"
                else "turned away the search's automatic check.")
    if code == "blocked":
        return "is on this site's list of sources not to use."
    if code == "identity":
        return {
            "no-name": f"doesn't show {person}'s name. It may only be in a video or image.",
            "no-identity-marker": (f"names {person}, but nothing near the name (such as a "
                                   "current or past job) shows it's the same person."),
            "exclusion": f"seems to be about someone else named {person}.",
        }.get(detail, f"doesn't clearly show {person}.")
    if code == "no-match":
        return f"mentions {person}, but doesn't name this item the way the search expected."
    if code == "not-fetched":
        return "wasn't checked."
    if code == "unusable-address":
        return "isn't a usable web address."
    return None


WHOLE_PROBLEMS = {
    "no-second-source": "Only one website backed it up, and the search needs two separate ones.",
    "no-entry": "It checked out, but details such as an exact date were missing, so no draft "
                "could be made.",
    "draft-failed": "It checked out, but creating the draft failed. It will be tried again "
                    "next time.",
    "internal-error": "Something went wrong while checking it.",
}


def _why(cand: Candidate, problems, person: str) -> list[str]:
    lines = []
    for prob in problems:
        if prob.url:
            text = _problem_text(prob, person)
            if text is None:
                continue
            if prob.url == cand.primary_url:
                lines += [f"• The main link {text}", ""]
            else:
                lines += [f"• This other page {text}", "", _plain_url(prob.url), ""]
        else:
            lines += [f"• {WHOLE_PROBLEMS.get(prob.code, 'It could not be confirmed.')}", ""]
    if not lines:
        lines = ["• It could not be confirmed.", ""]
    return ["Why:", "", *lines]


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def render_digest(site_label: str, person_name: str, new_drafts, unconfirmed, would_add=(),
                  *, review_link: str = "", preview: bool = False) -> tuple[str, str] | None:
    """The run's email, in plain words for a non-technical reader.

    `new_drafts` is the candidate of each draft opened in the website editor (a
    normal run); `would_add` the candidate of each confirmed find in a preview
    (email-only) run, where nothing is written; `unconfirmed` is (candidate,
    problems). Returns None, so no email is sent, when there is nothing to say."""
    ready = list(would_add if preview else new_drafts)
    if not ready and not unconfirmed:
        return None
    site = _clean(site_label, 100)
    person = _clean(person_name, 100) or "this person"
    parts = []
    if ready:
        parts.append(_plural(len(ready), "new item", "new items") + " for the site")
    if unconfirmed:
        parts.append(f"{len(unconfirmed)} to double-check")
    subject = f"{site} media search: {', '.join(parts)}" + (" (preview)" if preview else "")

    lines = [f"This is the regular search for new mentions of {person} to add to {site}.", ""]
    if preview:
        lines += ["This was a preview run, so nothing on the website was changed.", ""]
    if ready:
        lines += ["", RULE, "", f"READY TO ADD ({len(ready)})", ""]
        lines += ["Two separate websites confirmed "
                  + ("this one." if len(ready) == 1 else "each of these."), ""]
        if not preview:
            lines += [("It's waiting for you as a draft addition in the website editor. "
                       "Publish or delete it there:"
                       if len(ready) == 1 else
                       "They're waiting for you as draft additions in the website editor. "
                       "Publish or delete each one there:"), ""]
            if review_link:
                lines += [_plain_url(review_link), ""]
        for cand in ready:
            lines += ["", *_heading(cand), ""]
        if preview:
            lines += [("In a normal run, this would be waiting for you as a draft addition "
                       "in the website editor. You'd publish or delete it there."
                       if len(ready) == 1 else
                       "In a normal run, these would be waiting for you as draft additions "
                       "in the website editor. You'd publish or delete each one there."), ""]
    if unconfirmed:
        lines += ["", RULE, "", f"COULDN'T CONFIRM ({len(unconfirmed)})", "",
                  "These may be real, but the search couldn't verify them on its own, so "
                  "nothing was drafted. Open a link if you'd like to check yourself.", ""]
        for n, (cand, problems) in enumerate(unconfirmed, 1):
            head = _heading(cand)
            lines += ["", f"{n}. {head[0]}", *head[1:], "", *_why(cand, problems, person)]
    if preview:
        lines += ["", RULE, "", "PREVIEW RUN VS. NORMAL RUN", "",
                  "Only in this preview run:",
                  "  • Nothing on the website is added or changed.",
                  "  • Items ready to add are described in full here, since there's no draft "
                  "to open.", "",
                  "Only in a normal run:",
                  "  • Each item ready to add becomes a draft addition in the website editor.",
                  "  • This email links straight to the drafts, so you can publish or delete "
                  "each one.", "",
                  "The same in both:",
                  "  • The \"Couldn't confirm\" list.", ""]
    return subject, "\n".join(lines).rstrip("\n") + "\n"
