from media_discovery.placement import date_key, front_matter, place_media


def md(cat, w, date):
    return f"---\ncategory: {cat}\ndate_display: '{date}'\nweight: {w}\n---\nbody\n"


def sib(p, cat, w, date):
    return (p, md(cat, w, date))


def test_front_matter_reads_quoted_and_plain_values():
    fm = front_matter('---\ncategory: "A & B"\nweight: 7\ndate_display: \'It\'\'s\'\n---\n')
    assert fm == {"category": "A & B", "weight": 7, "date_display": "It's"}
    assert front_matter("no front matter") == {}
    assert front_matter("---\nweight: x\n---\n")["weight"] is None
    assert front_matter("---\nweight: true\n---\n")["weight"] is None
    assert front_matter("---\n: : [\n---\n") == {}


def test_date_keys_match_the_site_check():
    assert date_key("May 2026") == (2026, 5)
    assert date_key("2016") == (2016, None)
    assert date_key("Ongoing") is None
    assert date_key("") is None
    assert date_key(None) is None


def test_nothing_older_goes_last_and_nothing_moves():
    content, moves = place_media(md("X", 1, "May 2020"),
                                 [sib("a", "X", 1, "May 2026"), sib("b", "X", 2, "")])
    assert content == md("X", 3, "May 2020") and moves == []


def test_empty_category_keeps_its_own_weight():
    content, moves = place_media(md("X", 1, "May 2020"), [sib("a", "Y", 1, "May 2010")])
    assert content == md("X", 1, "May 2020") and moves == []


def test_newest_goes_first_and_every_item_moves_down_one():
    content, moves = place_media(md("X", 5, "2027"),
                                 [sib("b", "X", 1, "2020"), sib("a", "X", 0, "May 2026")])
    assert content == md("X", 0, "2027")
    assert moves == [sib("a", "X", 1, "May 2026"), sib("b", "X", 2, "2020")]


def test_a_same_year_bare_year_is_not_older():
    content, moves = place_media(md("X", 1, "May 2026"),
                                 [sib("a", "X", 1, "2026"), sib("b", "X", 2, "2025")])
    assert content == md("X", 2, "May 2026")
    assert moves == [sib("b", "X", 3, "2025")]


def test_undated_new_item_goes_last():
    content, moves = place_media(md("X", 1, ""), [sib("a", "X", 1, "2026"), sib("b", "X", 2, "2025")])
    assert content == md("X", 3, "") and moves == []


def test_only_the_front_matter_weight_line_changes():
    text = "---\ncategory: X\ndate_display: '2020'\nweight: 4\n---\nweight: 4 stays in the body\n"
    content, moves = place_media(text, [("a", md("X", 4, "2019"))])
    assert content == text
    assert moves == [("a", md("X", 5, "2019"))]
