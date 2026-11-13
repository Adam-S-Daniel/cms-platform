"""python3 -m media_discovery.fetch_probe --findings FILE --site-root DIR

Compares the urllib fetch with the headless-browser fetch for every URL in a
findings.json, for an isolated Actions test that needs no Claude API. The
output is public, so each line carries only counts and codes: the URL's index,
status, text length and identity reason for each fetcher, and whether the page
was a PDF. Never a URL, text or name. Exits 0 when pages fail, 1 on a crash.
"""

import argparse
import json
import sys
from pathlib import Path

from .browser import BrowserSession
from .config import load_config
from .fetch import fetch
from .identity import check_identity

CONFIG_PATH = ".github/media-discovery.yml"


def _urls(findings: dict) -> list[str]:
    out: list[str] = []
    for f in findings.get("findings", []):
        for url in [f.get("primary_url"), *(f.get("other_urls") or [])]:
            if isinstance(url, str) and url and url not in out:
                out.append(url)
    return out


def _summary(page, person) -> str:
    if page is None:
        return "unavailable"
    reason = check_identity(page.text, person).reason if 200 <= page.status < 300 else "skipped"
    return f"status={page.status} len={len(page.text)} identity={reason}"


def _is_pdf(url: str, page) -> bool:
    return url.split("?", 1)[0].lower().endswith(".pdf") or bool(
        page is not None and page.final_url.split("?", 1)[0].lower().endswith(".pdf"))


def run(findings: dict, person, *, fetcher=fetch, browser_factory=BrowserSession, say=print) -> dict:
    urls = _urls(findings)
    totals = dict(urls=len(urls), urllib_ok=0, browser_ok=0, browser_unavailable=0)
    with browser_factory() as browser:
        for i, url in enumerate(urls, 1):
            plain = fetcher(url)
            rendered = browser.fetch(url)
            totals["urllib_ok"] += 200 <= plain.status < 300
            totals["browser_ok"] += rendered is not None and 200 <= rendered.status < 300
            totals["browser_unavailable"] += rendered is None
            say(f"url {i}: urllib {_summary(plain, person)} | browser {_summary(rendered, person)}"
                f" | pdf={'yes' if _is_pdf(url, plain) else 'no'}")
    say("totals: " + " ".join(f"{k}={v}" for k, v in totals.items()))
    return totals


def main(argv=None, *, fetcher=fetch, browser_factory=BrowserSession, out=None) -> int:
    p = argparse.ArgumentParser(prog="python3 -m media_discovery.fetch_probe")
    p.add_argument("--findings", required=True, type=Path)
    p.add_argument("--site-root", required=True, type=Path)
    args = p.parse_args(argv)
    out = out or sys.stdout
    try:
        findings = json.loads(args.findings.read_text(encoding="utf-8"))
        cfg = load_config((args.site_root / CONFIG_PATH).read_text(encoding="utf-8"))
        run(findings, cfg.person, fetcher=fetcher, browser_factory=browser_factory,
            say=lambda line: print(line, file=out, flush=True))
    except Exception as exc:  # noqa: BLE001 - class only: messages can quote a URL
        print(f"::error::fetch probe crashed ({type(exc).__name__})", file=out, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
