from md_fixtures import CFG

from media_discovery.config import PersonConfig
from media_discovery.identity import check_identity

P = CFG.person


def test_passes_with_marker_near_name_and_gives_snippet():
    r = check_identity("Today Pat Rivera of Northwind Legal spoke.", P)
    assert r.ok and r.reason == "ok" and r.marker == "Northwind Legal"
    assert r.name_matches == ["Pat Rivera"] and "Pat Rivera" in r.snippet


def test_doppelganger_rejected():
    r = check_identity("Pat Riveras of Northwind Legal spoke.", P)
    assert not r.ok and r.reason == "no-name"


def test_possessive_accepted():
    assert check_identity("Pat Rivera's team at Northwind Legal", P).ok


def test_middle_initial_period_literal_and_flexible_whitespace():
    assert check_identity("Pat  Q.\nRivera, Northwind Legal", P).ok
    assert check_identity("Pat QX Rivera, Northwind Legal", P).reason == "no-name"


def test_exclusion_near_name_rejects():
    r = check_identity("Pat Rivera of Bluebird Advisors, formerly Northwind Legal.", P)
    assert not r.ok and r.reason == "exclusion" and r.exclusion == "Bluebird Advisors"


def test_exclusion_far_from_name_does_not_reject():
    far = " filler" * 100
    assert check_identity(f"Pat Rivera, Northwind Legal.{far} Bluebird Advisors", P).ok


def test_marker_too_far_rejects():
    cfg = PersonConfig(("Pat Rivera",), ("Northwind Legal",), (), near_chars=50)
    near = "Pat Rivera " + "x" * 40 + " Northwind Legal"
    far = "Pat Rivera " + "x" * 80 + " Northwind Legal"
    assert check_identity(near, cfg).ok
    r = check_identity(far, cfg)
    assert not r.ok and r.reason == "no-identity-marker"


def test_marker_before_name_counts():
    assert check_identity("Office of Data Policy veteran Pat Rivera", P).ok


def test_uppercase_marker_is_case_sensitive_and_whole_word():
    assert check_identity("Pat Rivera, ODP", P).ok
    assert not check_identity("Pat Rivera, odp", P).ok
    assert not check_identity("Pat Rivera, ODPX", P).ok


def test_mixed_case_marker_is_case_insensitive():
    assert check_identity("Pat Rivera, northwind LEGAL", P).ok


def test_one_good_mention_among_excluded_ones_passes():
    far = " filler" * 100
    text = f"Pat Rivera Bluebird Advisors.{far} Pat Rivera, Northwind Legal."
    assert check_identity(text, P).ok


def test_no_marker_for_any_name():
    r = check_identity("Pat Rivera gave a talk.", P)
    assert r.reason == "no-identity-marker" and r.name_matches == ["Pat Rivera"]
