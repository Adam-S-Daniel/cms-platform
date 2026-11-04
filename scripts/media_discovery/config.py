"""Parse and validate a site's .github/media-discovery.yml."""

from dataclasses import dataclass, field
from pathlib import PurePosixPath
from urllib.parse import urlsplit

import yaml

from .domains import registrable_domain


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class PersonConfig:
    names: tuple[str, ...]
    identity_markers: tuple[str, ...]
    exclusion_markers: tuple[str, ...] = ()
    near_chars: int = 600


@dataclass(frozen=True)
class SourcesConfig:
    blocked_domains: tuple[str, ...] = ()
    seed_urls: tuple[str, ...] = ()


@dataclass(frozen=True)
class MediaCollection:
    folder: str = "_media"
    weight: int = 1


@dataclass(frozen=True)
class EventsCollection:
    folder: str = "_events"


@dataclass(frozen=True)
class CollectionsConfig:
    media: MediaCollection = field(default_factory=MediaCollection)
    events: EventsCollection = field(default_factory=EventsCollection)


@dataclass(frozen=True)
class Config:
    person: PersonConfig
    sources: SourcesConfig = field(default_factory=SourcesConfig)
    search_hints: tuple[str, ...] = ()
    collections: CollectionsConfig = field(default_factory=CollectionsConfig)


def _mapping(value, where: str, allowed: set[str]) -> dict:
    if not isinstance(value, dict):
        raise ConfigError(f"{where} must be a mapping")
    unknown = sorted(set(value) - allowed)
    if unknown:
        raise ConfigError(f"{where} has unknown key(s): {', '.join(map(str, unknown))}")
    return value


def _strings(value, where: str, *, min_items: int = 0) -> tuple[str, ...]:
    if value is None:
        value = []
    if not isinstance(value, list):
        raise ConfigError(f"{where} must be a list")
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ConfigError(f"{where} must contain only non-empty strings")
    if len(value) < min_items:
        raise ConfigError(f"{where} needs at least {min_items} item(s)")
    return tuple(item.strip() for item in value)


def _folder(value, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{where} must be a non-empty string")
    path = PurePosixPath(value.strip())
    if path.is_absolute() or ".." in path.parts or "\\" in value:
        raise ConfigError(f"{where} must be a relative folder inside the repository")
    return str(path)


def load_config(text: str) -> Config:
    try:
        raw = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise ConfigError(f"not valid YAML: {exc}") from exc
    root = _mapping(raw, "the config", {"person", "sources", "search_hints", "collections"})
    if "person" not in root:
        raise ConfigError("person is required")

    p = _mapping(root["person"], "person",
                 {"names", "identity_markers", "exclusion_markers", "near_chars"})
    near = p.get("near_chars", 600)
    if isinstance(near, bool) or not isinstance(near, int) or not 1 <= near <= 5000:
        raise ConfigError("person.near_chars must be an integer from 1 to 5000")
    person = PersonConfig(
        names=_strings(p.get("names"), "person.names", min_items=1),
        identity_markers=_strings(p.get("identity_markers"), "person.identity_markers",
                                  min_items=1),
        exclusion_markers=_strings(p.get("exclusion_markers"), "person.exclusion_markers"),
        near_chars=near,
    )

    s = _mapping(root.get("sources") or {}, "sources", {"blocked_domains", "seed_urls"})
    try:
        blocked = tuple(registrable_domain(d)
                        for d in _strings(s.get("blocked_domains"), "sources.blocked_domains"))
    except ValueError as exc:
        raise ConfigError(f"sources.blocked_domains: {exc}") from exc
    seeds = _strings(s.get("seed_urls"), "sources.seed_urls")
    for url in seeds:
        parts = urlsplit(url)
        if parts.scheme != "https" or not parts.hostname:
            raise ConfigError(f"sources.seed_urls must be https URLs: {url!r}")
    sources = SourcesConfig(blocked_domains=blocked, seed_urls=seeds)

    c = _mapping(root.get("collections") or {}, "collections", {"media", "events"})
    m = _mapping(c.get("media") or {}, "collections.media", {"folder", "weight"})
    weight = m.get("weight", 1)
    if isinstance(weight, bool) or not isinstance(weight, int) or weight < 0:
        raise ConfigError("collections.media.weight must be a non-negative integer")
    e = _mapping(c.get("events") or {}, "collections.events", {"folder"})
    collections = CollectionsConfig(
        media=MediaCollection(_folder(m.get("folder", "_media"), "collections.media.folder"),
                              weight),
        events=EventsCollection(_folder(e.get("folder", "_events"),
                                        "collections.events.folder")),
    )

    return Config(person=person, sources=sources,
                  search_hints=_strings(root.get("search_hints"), "search_hints"),
                  collections=collections)
