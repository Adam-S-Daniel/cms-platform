from datetime import date

from md_fixtures import CFG, PAGE_A, PAGE_B, make_candidate, page

from media_discovery.config import load_config
from media_discovery.corroborate import Problem, classify_timing, effective_kind, verify

PRIMARY = "https://events.example.com/talks/open-data"
SECOND = "https://news.example.org/summit-recap"


def pages(a=PAGE_A, b=PAGE_B, **kw):
    return {PRIMARY: page(PRIMARY, a), SECOND: page(SECOND, b, **kw)}


def test_two_different_pages_on_different_domains_confirm():
    v = verify(make_candidate(), pages(), CFG)
    assert v.confirmed, v.reasons
    assert [s.cluster for s in v.sources] == [0, 1]


def test_syndicated_copy_is_not_independent():
    v = verify(make_candidate(), pages(b=PAGE_A + " Syndicated."), CFG)
    assert not v.confirmed
    assert v.sources[0].cluster == v.sources[1].cluster
    assert "no independent second source" in v.reasons


def test_same_registrable_domain_is_not_independent():
    sup = "https://blog.example.com/recap"
    cand = make_candidate(supporting_urls=[sup])
    v = verify(cand, {PRIMARY: page(PRIMARY, PAGE_A), sup: page(sup, PAGE_B)}, CFG)
    assert not v.confirmed


def test_blocked_domain_does_not_count():
    sup = "https://www.blocked.example.net/recap"
    cand = make_candidate(supporting_urls=[sup])
    v = verify(cand, {PRIMARY: page(PRIMARY, PAGE_A), sup: page(sup, PAGE_B)}, CFG)
    assert not v.confirmed and v.sources[1].blocked


def test_blocked_via_final_url_does_not_count():
    v = verify(make_candidate(),
               pages(final="https://redirect.blocked.example.net/x"), CFG)
    assert not v.confirmed


def test_hostless_final_url_is_unusable_not_a_crash():
    v = verify(make_candidate(), pages(a=PAGE_A, b=PAGE_B) | {
        PRIMARY: page(PRIMARY, "", status=0, final="http:///x")}, CFG)
    assert not v.confirmed
    assert f"{PRIMARY}: unusable address" in v.reasons
    assert "http:///x" not in " ".join(v.reasons)


def test_blocked_primary_fails():
    cfg = load_config("person: {names: [Pat Rivera], identity_markers: [Northwind Legal]}\n"
                      "sources: {blocked_domains: [example.com]}")
    assert not verify(make_candidate(), pages(), cfg).confirmed


def test_primary_must_contain_title_not_just_outlet():
    text = "Example Summit 2026: Pat Rivera, Northwind Legal, was there."
    v = verify(make_candidate(), pages(a=text), CFG)
    assert not v.confirmed and v.reasons[0] == "primary source does not check out"


def test_supporting_may_match_outlet_for_talks_only():
    outlet_only = "Example Summit 2026 recap. Pat Rivera, Northwind Legal, spoke."
    assert verify(make_candidate(), pages(b=outlet_only), CFG).confirmed
    assert not verify(make_candidate(kind="press"), pages(b=outlet_only), CFG).confirmed


def test_missing_year_fails():
    v = verify(make_candidate(), pages(a=PAGE_A.replace("2026", "")), CFG)
    assert not v.confirmed


def test_non_2xx_and_missing_pages_fail():
    assert not verify(make_candidate(), pages(status=404), CFG).confirmed
    only_primary = {PRIMARY: page(PRIMARY, PAGE_A)}
    v = verify(make_candidate(), only_primary, CFG)
    assert not v.confirmed and any("not fetched" in r for r in v.reasons)


def test_identity_failure_on_supporting_fails():
    v = verify(make_candidate(), pages(b=PAGE_B.replace("Pat Rivera", "Pat Riveras")), CFG)
    assert not v.confirmed


def test_no_supporting_urls():
    v = verify(make_candidate(supporting_urls=[]), {PRIMARY: page(PRIMARY, PAGE_A)}, CFG)
    assert not v.confirmed


def test_timing_month_counts_as_last_day():
    c = make_candidate(date="2026-11")
    assert classify_timing(c, date(2026, 11, 30)) == "upcoming"
    assert classify_timing(c, date(2026, 12, 1)) == "past"


def test_timing_uses_end_date_and_day_precision():
    c = make_candidate(date="2026-11-02", end_date="2026-11-05")
    assert classify_timing(c, date(2026, 11, 5)) == "upcoming"
    assert classify_timing(c, date(2026, 11, 6)) == "past"
    assert classify_timing(make_candidate(date="2026-11-04"), date(2026, 11, 4)) == "upcoming"


def test_effective_kind_ignores_model_label_for_talks_only():
    assert effective_kind(make_candidate(kind="upcoming_talk", date="2020-01-01"),
                          date(2026, 11, 4)) == "past_talk"
    assert effective_kind(make_candidate(kind="past_talk", date="2030-01-01"),
                          date(2026, 11, 4)) == "upcoming_talk"
    assert effective_kind(make_candidate(kind="press", date="2030-01-01"),
                          date(2026, 11, 4)) == "press"


def test_problems_name_each_failure_for_the_digest():
    v = verify(make_candidate(), {PRIMARY: page(PRIMARY, PAGE_A),
                                  SECOND: page(SECOND, "Pat Rivera, Northwind Legal. 2026")}, CFG)
    assert v.problems == [Problem("no-match", SECOND), Problem("no-second-source")]
    unreadable = page(PRIMARY, "", status=415)
    unreadable.unreadable_type = True
    v = verify(make_candidate(), {PRIMARY: unreadable, SECOND: page(SECOND, PAGE_B, status=406)},
               CFG)
    assert v.problems == [Problem("unreadable-type", PRIMARY),
                          Problem("http-status", SECOND, "406")]
    v = verify(make_candidate(), pages(b=PAGE_B.replace("Northwind Legal", "")), CFG)
    assert v.problems == [Problem("identity", SECOND, "no-identity-marker"),
                          Problem("no-second-source")]
    v = verify(make_candidate(), {PRIMARY: page(PRIMARY, PAGE_A)}, CFG)
    assert v.problems == [Problem("not-fetched", SECOND), Problem("no-second-source")]
