"""fetch_probe output: codes and counts only, never a URL, text or name."""

import io
import json

from md_fixtures import CONFIG_YAML, PAGE_A, page

from media_discovery.fetch_probe import main

URL_A = "https://events.example.com/talks/open-data"
URL_B = "https://files.example.net/agenda.pdf"
FINDINGS = {"findings": [
    {"primary_url": URL_A, "other_urls": [URL_B, URL_A]},
    {"primary_url": "https://blocked.example.org/x", "other_urls": []},
]}


class Browser:
    def __enter__(self):
        return self

    def __exit__(self, *e):
        return False

    def fetch(self, url):
        if "blocked" in url:
            return None
        return page(url, PAGE_A)


def fetcher(url):
    return page(url, "", 403) if "blocked" in url else page(url, PAGE_A if "talks" in url else "x")


def run(tmp_path, **kw):
    (tmp_path / ".github").mkdir()
    (tmp_path / ".github" / "media-discovery.yml").write_text(CONFIG_YAML, encoding="utf-8")
    f = tmp_path / "findings.json"
    f.write_text(json.dumps(FINDINGS), encoding="utf-8")
    out = io.StringIO()
    code = main(["--findings", str(f), "--site-root", str(tmp_path)], fetcher=fetcher,
                browser_factory=Browser, out=out, **kw)
    return code, out.getvalue()


def test_one_line_per_url_with_totals_and_no_private_data(tmp_path):
    code, text = run(tmp_path)
    assert code == 0
    lines = text.strip().splitlines()
    assert len(lines) == 4  # three distinct URLs plus totals
    assert lines[0].startswith("url 1: urllib status=200 len=")
    assert "identity=ok" in lines[0] and "pdf=no" in lines[0]
    assert "pdf=yes" in lines[1]
    assert "status=403 len=0 identity=skipped | browser unavailable | pdf=no" in lines[2]
    assert lines[3] == "totals: urls=3 urllib_ok=2 browser_ok=2 browser_unavailable=1"
    for private in ("example", "Pat", "Rivera", "Northwind", "http", "Summit"):
        assert private not in text


def test_a_crash_exits_one_without_a_message(tmp_path):
    out = io.StringIO()
    code = main(["--findings", str(tmp_path / "missing.json"), "--site-root", str(tmp_path)],
                fetcher=fetcher, browser_factory=Browser, out=out)
    assert code == 1 and "FileNotFoundError" in out.getvalue() and "missing" not in out.getvalue()
