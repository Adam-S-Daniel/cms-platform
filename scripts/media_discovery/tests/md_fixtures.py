"""Shared fictional fixtures: Pat Rivera and example.* hosts only."""

from media_discovery.candidate import Candidate
from media_discovery.config import load_config
from media_discovery.corroborate import FetchedPage

CONFIG_YAML = """
person:
  names: ["Pat Rivera", "Pat Q. Rivera", "Patricia Quinn Rivera"]
  identity_markers: ["Northwind Legal", "Office of Data Policy", "ODP"]
  exclusion_markers: ["Bluebird Advisors"]
  near_chars: 200
sources:
  blocked_domains: ["blocked.example.net"]
"""

CFG = load_config(CONFIG_YAML)


def make_candidate(**kw) -> Candidate:
    base = dict(
        kind="past_talk", title="Open Data in Practice", outlet="Example Summit",
        date="2026-03-12", primary_url="https://events.example.com/talks/open-data",
        supporting_urls=["https://news.example.org/summit-recap"],
        reasoning="Bio matches.",
    )
    base.update(kw)
    return Candidate(**base)


PAGE_A = ("Open Data in Practice at the Example Summit 2026. Speaker Pat Rivera of "
          "Northwind Legal discusses how agencies publish datasets. " + "alpha " * 30)
PAGE_B = ("Recap: the Example Summit 2026 closed with a panel called Open Data in "
          "Practice. Pat Rivera, Northwind Legal, argued for plain language. " + "bravo " * 30)


def page(url, text, status=200, final=None) -> FetchedPage:
    return FetchedPage(url, final or url, status, text)
