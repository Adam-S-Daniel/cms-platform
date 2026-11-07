"""Decide whether a candidate is real: two independent pages must back it up."""

import re
from dataclasses import dataclass, field
from datetime import date

from .candidate import TALK_KINDS, Candidate, parse_date
from .config import Config
from .domains import is_blocked, registrable_domain
from .identity import IdentityResult, check_identity
from .text import normalize

SHINGLE_WORDS = 8
SAME_CLUSTER_JACCARD = 0.6


@dataclass
class FetchedPage:
    url: str
    final_url: str
    status: int
    text: str


@dataclass
class SourceResult:
    url: str
    domain: str
    identity: IdentityResult | None
    supports_claim: bool
    blocked: bool
    cluster: int  # -1 when the page was not fetched


@dataclass
class Verdict:
    confirmed: bool
    reasons: list[str] = field(default_factory=list)
    sources: list[SourceResult] = field(default_factory=list)


def classify_timing(candidate: Candidate, today: date) -> str:
    """'upcoming' when the end (or only) date, a bare month counting as its last day,
    is today or later; otherwise 'past'."""
    if candidate.end_date:
        end = parse_date(candidate.end_date)
    else:
        end = parse_date(candidate.date, end_of_month=True)
    return "upcoming" if end >= today else "past"


def effective_kind(candidate: Candidate, today: date) -> str:
    """The model's upcoming/past label is not trusted; talks are labeled by date."""
    if candidate.kind not in TALK_KINDS:
        return candidate.kind
    return "upcoming_talk" if classify_timing(candidate, today) == "upcoming" else "past_talk"


def _shingles(norm_text: str) -> set[tuple[str, ...]]:
    words = norm_text.split()
    if len(words) < SHINGLE_WORDS:
        return {tuple(words)} if words else set()
    return {tuple(words[i:i + SHINGLE_WORDS]) for i in range(len(words) - SHINGLE_WORDS + 1)}


def _jaccard(a: set, b: set) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _supports(candidate: Candidate, norm_text: str, *, need_title: bool) -> bool:
    title = normalize(candidate.title)
    outlet = normalize(candidate.outlet)
    has_title = bool(title) and title in norm_text
    has_outlet = (candidate.kind in TALK_KINDS and not need_title
                  and bool(outlet) and outlet in norm_text)
    year = candidate.date[:4]
    return (has_title or has_outlet) and re.search(rf"(?<!\d){year}(?!\d)", norm_text) is not None


def _domain(*urls: str) -> str:
    """Registrable domain of the first URL that has a host, else "" (never raises)."""
    for url in urls:
        try:
            return registrable_domain(url)
        except ValueError:
            continue
    return ""


def _blocked(url: str, blocked_domains) -> bool:
    try:
        return is_blocked(url, blocked_domains)
    except ValueError:
        return False  # a hostless address is unusable, not blocked


def verify(candidate: Candidate, pages: dict[str, FetchedPage], cfg: Config) -> Verdict:
    urls = list(dict.fromkeys([candidate.primary_url, *candidate.supporting_urls]))
    reasons: list[str] = []
    sources: list[SourceResult] = []
    qualified: list[bool] = []
    clusters: list[tuple[str, set, int]] = []  # (domain, shingles, id) of each cluster seed

    for url in urls:
        page = pages.get(url)
        is_primary = url == candidate.primary_url
        if page is None:
            sources.append(SourceResult(url, _domain(url), None, False, False, -1))
            qualified.append(False)
            reasons.append(f"not fetched: {url}")
            continue
        final = page.final_url or url
        domain = _domain(final, url)
        if not _domain(final) or not _domain(url):
            # Never echo a hostless address: name the candidate's own URL instead.
            sources.append(SourceResult(url, domain, None, False, False, -1))
            qualified.append(False)
            reasons.append(f"{url}: unusable address")
            continue
        blocked = (_blocked(url, cfg.sources.blocked_domains)
                   or _blocked(final, cfg.sources.blocked_domains))
        ok_status = 200 <= page.status < 300
        identity = check_identity(page.text, cfg.person) if ok_status else None
        norm = normalize(page.text)
        supports = ok_status and _supports(candidate, norm, need_title=is_primary)
        sh = _shingles(norm)
        cluster = next((cid for d, s, cid in clusters
                        if d == domain or _jaccard(sh, s) >= SAME_CLUSTER_JACCARD), None)
        if cluster is None:
            cluster = len(clusters)
            clusters.append((domain, sh, cluster))
        sources.append(SourceResult(url, domain, identity, supports, blocked, cluster))
        qualified.append(ok_status and not blocked and bool(identity and identity.ok)
                         and supports)
        if not qualified[-1]:
            why = ("blocked domain" if blocked else
                   f"HTTP status {page.status}" if not ok_status else
                   f"identity check failed ({identity.reason})" if not identity.ok else
                   "does not support the claim")
            reasons.append(f"{url}: {why}")

    confirmed = False
    if not qualified[0]:
        reasons.insert(0, "primary source does not check out")
    else:
        primary_cluster = sources[0].cluster
        confirmed = any(q and s.cluster != primary_cluster
                        for q, s in zip(qualified[1:], sources[1:]))
        if not confirmed:
            reasons.append("no independent second source")
    return Verdict(confirmed, reasons, sources)
