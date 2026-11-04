"""Domain and URL helpers: registrable domains, blocklist checks, dedupe keys."""

from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

# Deliberately small: no network and no Public Suffix List download. Any host
# whose last two labels are not listed here is treated as a plain eTLD+1 (last
# two labels), so an unlisted multi-part suffix (say "co.za") errs toward
# treating all of its sites as ONE domain, which can only make corroboration
# stricter, never looser.
_MULTI_PART_SUFFIXES = frozenset({
    "co.uk", "org.uk", "ac.uk", "gov.uk",
    "com.au", "org.au", "net.au", "gov.au",
    "co.nz", "co.jp", "com.br", "co.in", "gc.ca",
})

_TRACKING_PARAMS = {"fbclid", "gclid"}
_PATH_SAFE = "/%:@!$&'()*+,;=~-._"


def _host(host_or_url: str) -> str:
    raw = host_or_url.strip()
    if "//" not in raw:
        raw = "//" + raw
    host = urlsplit(raw).hostname
    if not host:
        raise ValueError(f"no host in {host_or_url!r}")
    host = host.rstrip(".")
    return host[4:] if host.startswith("www.") else host


def registrable_domain(host_or_url: str) -> str:
    host = _host(host_or_url)
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if ".".join(labels[-2:]) in _MULTI_PART_SUFFIXES:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def is_blocked(url: str, blocked_domains) -> bool:
    return registrable_domain(url) in set(blocked_domains)


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    if parts.scheme.lower() not in ("http", "https"):
        raise ValueError(f"only http(s) URLs are allowed: {url!r}")
    host = _host(url)
    port = parts.port
    default = 443 if parts.scheme.lower() == "https" else 80
    netloc = host if port in (None, default) else f"{host}:{port}"
    query = sorted(
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in _TRACKING_PARAMS
    )
    path = quote(parts.path, safe=_PATH_SAFE)
    path = path.rstrip("/") or "/"
    return urlunsplit((parts.scheme.lower(), netloc, path, urlencode(query), ""))
