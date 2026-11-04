"""Skip candidates the site already has, or that an earlier discovery PR already proposed."""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

from .candidate import Candidate
from .config import Config
from .domains import normalize_url

PR_MARKER_RE = re.compile(r"<!-- media-discovery:v1 url=(\S+) -->")


@dataclass(frozen=True)
class ExistingItem:
    url: str | None
    title: str


def pr_marker(url: str) -> str:
    return f"<!-- media-discovery:v1 url={normalize_url(url)} -->"


def urls_from_pr_bodies(bodies) -> set[str]:
    found: set[str] = set()
    for body in bodies:
        for raw in PR_MARKER_RE.findall(body or ""):
            try:
                found.add(normalize_url(raw))
            except ValueError:
                pass
    return found


def _title_key(title: str) -> str:
    return "".join(ch for ch in title.casefold() if ch.isalnum())


def _norm_or_none(url) -> str | None:
    try:
        return normalize_url(url)
    except (ValueError, AttributeError):
        return None


def is_duplicate(candidate: Candidate, existing: list[ExistingItem],
                 prior_pr_urls: set[str]) -> str | None:
    wanted = {u for u in map(_norm_or_none, [candidate.primary_url, *candidate.supporting_urls])
              if u}
    if wanted & prior_pr_urls:
        return "an earlier discovery PR already proposed this URL"
    existing_urls = {u for u in (_norm_or_none(i.url) for i in existing) if u}
    if wanted & existing_urls:
        return "the site already links this URL"
    key = _title_key(candidate.title)
    if key and any(_title_key(i.title) == key for i in existing):
        return "the site already has an item with this title"
    return None


def _front_matter(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    try:
        data = yaml.safe_load(text[3:end])
    except yaml.YAMLError:
        return {}
    return data if isinstance(data, dict) else {}


def load_existing(repo_root: Path, cfg: Config) -> list[ExistingItem]:
    items: list[ExistingItem] = []
    for folder, url_key in ((cfg.collections.media.folder, "article_url"),
                            (cfg.collections.events.folder, "event_url")):
        for path in sorted((Path(repo_root) / folder).glob("*.md")):
            data = _front_matter(path)
            url, title = data.get(url_key), data.get("title")
            items.append(ExistingItem(url if isinstance(url, str) and url else None,
                                      title if isinstance(title, str) else ""))
    return items
