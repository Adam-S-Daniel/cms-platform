"""Fetch a candidate's source page for the corroboration checks, safely.

The URLs come from a language model that read the open web, so they are
untrusted: every hop is limited to http(s), and its host must resolve only to
public addresses. A GitHub-hosted runner can reach link-local metadata and
private endpoints, which is what the address check keeps out of reach.
Redirects are followed by hand so each hop gets the same checks.

Known limit: the address check resolves the host, then urllib resolves it again
to connect, so a host that answers differently the second time (DNS rebinding)
is not caught. The fetched text is only ever matched against the candidate,
never printed to a log, which bounds what such a fetch could leak.
"""

import ipaddress
import socket
import urllib.error
import urllib.request
from urllib.parse import urljoin, urlsplit

from .corroborate import FetchedPage
from .text import html_to_text

TIMEOUT_SECONDS = 20
MAX_BYTES = 3 * 1024 * 1024
MAX_REDIRECTS = 5
USER_AGENT = "cms-platform-media-discovery/1"
ACCEPTED_TYPES = ("text/html", "application/xhtml+xml", "text/plain")
_REDIRECT_CODES = (301, 302, 303, 307, 308)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Hand every 3xx back to fetch() as an HTTPError instead of following it."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _default_opener():
    return urllib.request.build_opener(_NoRedirect)


def _default_resolver(host: str, port: int) -> list[str]:
    return [info[4][0] for info in socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)]


def _host_is_public(host: str, port: int, resolver) -> bool:
    try:
        addresses = resolver(host, port)
    except (OSError, UnicodeError, ValueError):
        return False
    if not addresses:
        return False
    for address in addresses:
        try:
            ip = ipaddress.ip_address(str(address).split("%", 1)[0])
        except ValueError:
            return False
        if not ip.is_global:
            return False
    return True


def _allowed(url: str, resolver) -> bool:
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    if port is None:
        port = 443 if parts.scheme == "https" else 80
    return _host_is_public(parts.hostname, port, resolver)


def _body(resp, final_url: str, url: str) -> FetchedPage:
    headers = resp.headers
    content_type = headers.get_content_type() if headers is not None else ""
    status = getattr(resp, "status", None) or resp.getcode()
    if content_type not in ACCEPTED_TYPES:
        return FetchedPage(url, final_url, 415, "", unreadable_type=True)
    raw = resp.read(MAX_BYTES)
    charset = headers.get_content_charset() or "utf-8"
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        text = raw.decode("utf-8", errors="replace")
    if content_type != "text/plain":
        text = html_to_text(text)
    return FetchedPage(url, final_url, status, text)


def fetch(url: str, *, opener=None, resolver=None) -> FetchedPage:
    """GET `url`; never raises. Status 0 means refused or a network failure,
    415 an unaccepted content type."""
    opener = opener or _default_opener()
    resolver = resolver or _default_resolver
    current = url
    try:
        for _ in range(MAX_REDIRECTS + 1):
            if not _allowed(current, resolver):
                return FetchedPage(url, current, 0, "")
            req = urllib.request.Request(current, headers={
                "User-Agent": USER_AGENT,
                "Accept": "text/html,application/xhtml+xml,text/plain;q=0.9",
            })
            try:
                resp = opener.open(req, timeout=TIMEOUT_SECONDS)
            except urllib.error.HTTPError as err:
                location = err.headers.get("Location") if err.headers is not None else None
                err.close()
                if err.code in _REDIRECT_CODES and location:
                    current = urljoin(current, location)
                    continue
                return FetchedPage(url, current, err.code, "")
            with resp:
                return _body(resp, current, url)
        return FetchedPage(url, current, 0, "")  # too many redirects
    except Exception:  # noqa: BLE001 - a fetch failure is data, not a crash
        return FetchedPage(url, current, 0, "")
