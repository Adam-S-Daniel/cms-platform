import pytest

from media_discovery.config import ConfigError, load_config
from media_discovery.domains import is_blocked, normalize_url, registrable_domain
from media_discovery.text import html_to_text, normalize


def test_normalize_quotes_dashes_case_space():
    assert normalize("  Pat\u2019s \u201cBig\u201d  Talk \u2014 Part\u00a02 ") == \
        "pat's \"big\" talk - part 2"


def test_html_to_text_drops_scripts_and_decodes():
    html = ("<html><head><style>x{}</style><script>var a=1;</script></head><body>"
            "<p>Law &amp; Order</p><noscript>no</noscript><div>Second<br>line</div></body></html>")
    out = html_to_text(html)
    assert "var a" not in out and "x{}" not in out and "no\n" not in out
    assert out.split("\n") == ["Law & Order", "Second", "line"]


@pytest.mark.parametrize("value,expected", [
    ("https://www.Example.com:8080/a", "example.com"),
    ("sub.deep.example.org", "example.org"),
    ("a.b.example.co.uk", "example.co.uk"),
    ("x.example.com.au", "example.com.au"),
    ("example.gc.ca", "example.gc.ca"),
    ("localhost", "localhost"),
])
def test_registrable_domain(value, expected):
    assert registrable_domain(value) == expected


def test_registrable_domain_rejects_empty():
    with pytest.raises(ValueError):
        registrable_domain("")


def test_is_blocked_by_registrable_domain():
    assert is_blocked("https://a.b.example.net/x", ["example.net"])
    assert not is_blocked("https://example.org/", ["example.net"])


def test_normalize_url():
    assert normalize_url(
        "HTTPS://WWW.Example.com/Path/?b=2&utm_source=x&a=1&fbclid=z&gclid=q#frag"
    ) == "https://example.com/Path?a=1&b=2"
    assert normalize_url("http://example.com") == "http://example.com/"
    assert normalize_url("https://example.com:443/a/") == "https://example.com/a"
    assert normalize_url("https://example.com/a>b") == "https://example.com/a%3Eb"


@pytest.mark.parametrize("bad", ["ftp://example.com/", "javascript:alert(1)", "//example.com/x"])
def test_normalize_url_rejects_non_http(bad):
    with pytest.raises(ValueError):
        normalize_url(bad)


def test_config_defaults():
    cfg = load_config("person: {names: [Pat Rivera], identity_markers: [ODP]}")
    assert cfg.person.near_chars == 600 and cfg.person.exclusion_markers == ()
    assert cfg.collections.media.folder == "_media" and cfg.collections.media.weight == 1
    assert cfg.collections.events.folder == "_events"
    assert cfg.sources.blocked_domains == () and cfg.search_hints == ()
    with pytest.raises(Exception):
        cfg.person.near_chars = 1  # frozen


def test_config_normalizes_blocked_domains():
    cfg = load_config("person: {names: [A B], identity_markers: [X]}\n"
                      "sources: {blocked_domains: ['https://www.sub.example.net/']}")
    assert cfg.sources.blocked_domains == ("example.net",)


@pytest.mark.parametrize("text,fragment", [
    ("[]", "mapping"),
    ("a: [", "YAML"),
    ("sources: {}", "person is required"),
    ("person: {names: [], identity_markers: [X]}", "person.names"),
    ("person: {names: [A B]}", "person.identity_markers"),
    ("person: {names: [A B], identity_markers: [X], near_chars: 0}", "near_chars"),
    ("person: {names: [A B], identity_markers: [X], near_chars: true}", "near_chars"),
    ("person: {names: [A B], identity_markers: [X], typo: 1}", "unknown key"),
    ("person: {names: [A B], identity_markers: [X]}\nsources: {seed_urls: ['http://example.com']}",
     "https"),
    ("person: {names: [A B], identity_markers: [X]}\ncollections: {media: {folder: ../x}}",
     "relative folder"),
    ("person: {names: [A B], identity_markers: [X]}\ncollections: {media: {weight: -1}}",
     "weight"),
    ("person: {names: [A, 3], identity_markers: [X]}", "non-empty strings"),
])
def test_config_errors(text, fragment):
    with pytest.raises(ConfigError, match=fragment):
        load_config(text)
