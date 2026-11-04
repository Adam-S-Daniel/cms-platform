from media_discovery.candidate import CANDIDATES_JSON_SCHEMA, KINDS, parse_candidates


def good(**kw):
    base = {
        "kind": "podcast", "title": "A Talk", "outlet": "Example Radio", "date": "2026-05",
        "end_date": None, "location": None, "session": None,
        "primary_url": "https://example.com/a", "supporting_urls": ["https://example.org/b"],
        "evidence": [{"url": "https://example.com/a", "quote": "Pat Rivera spoke."}],
        "reasoning": "Matches.",
    }
    base.update(kw)
    return base


def test_schema_is_strict_everywhere():
    def walk(node):
        if isinstance(node, dict):
            if node.get("type") == "object":
                assert node["additionalProperties"] is False
                assert sorted(node["required"]) == sorted(node["properties"])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(CANDIDATES_JSON_SCHEMA)
    item = CANDIDATES_JSON_SCHEMA["properties"]["candidates"]["items"]["properties"]
    assert item["title"]["maxLength"] == 300
    assert item["reasoning"]["maxLength"] == 1500
    assert item["evidence"]["items"]["properties"]["quote"]["maxLength"] == 600
    assert item["supporting_urls"]["maxItems"] == 8
    assert item["kind"]["enum"] == list(KINDS)
    for key in ("end_date", "location", "session"):
        assert item[key]["type"] == ["string", "null"]


def test_valid_candidate_parses():
    cands, drops = parse_candidates({"candidates": [good()]})
    assert drops == [] and cands[0].title == "A Talk" and cands[0].end_date is None
    assert cands[0].evidence[0]["quote"] == "Pat Rivera spoke."


def test_bad_items_are_dropped_with_reasons():
    bad = [
        good(kind="rumor"), good(title="  "), good(date="2026-13"), good(date="March 2026"),
        good(end_date="2026-04"), good(primary_url="ftp://example.com/a"),
        good(supporting_urls=["javascript:alert(1)"]),
        good(evidence=[{"url": "file:///etc/passwd", "quote": "x"}]),
        good(title="x" * 301), "not an object",
    ]
    cands, drops = parse_candidates({"candidates": [good(), *bad]})
    assert len(cands) == 1 and len(drops) == len(bad)


def test_non_dict_input():
    assert parse_candidates([])[0] == []
    assert parse_candidates({"candidates": "x"})[1]


def test_lists_and_text_are_capped():
    urls = [f"https://example.com/{i}" for i in range(12)]
    cands, _ = parse_candidates({"candidates": [good(supporting_urls=urls,
                                                     reasoning="r" * 2000)]})
    assert len(cands[0].supporting_urls) == 8 and len(cands[0].reasoning) == 1500
