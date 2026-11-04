from md_fixtures import CFG, make_candidate

from media_discovery.dedupe import (ExistingItem, is_duplicate, load_existing, pr_marker,
                                    urls_from_pr_bodies)


def test_duplicate_by_primary_or_supporting_url():
    c = make_candidate(primary_url="https://www.example.com/a/?utm_source=x",
                       supporting_urls=["https://example.org/b"])
    assert is_duplicate(c, [ExistingItem("https://example.com/a", "Other")], set())
    assert is_duplicate(c, [ExistingItem("http://x.example.net/", "T"),
                            ExistingItem("https://example.org/b/", "T2")], set())


def test_duplicate_by_title_alnum_casefold():
    c = make_candidate(title="Open Data: In Practice!")
    assert is_duplicate(c, [ExistingItem(None, "open data in practice")], set())


def test_duplicate_by_prior_pr():
    c = make_candidate()
    prior = urls_from_pr_bodies([f"intro\n{pr_marker(c.primary_url)}\nmore", None])
    assert is_duplicate(c, [], prior)


def test_not_duplicate():
    assert is_duplicate(make_candidate(), [ExistingItem("https://example.net/z", "Else")],
                        {"https://example.net/q"}) is None


def test_pr_marker_round_trip_and_ignores_garbage():
    m = pr_marker("https://WWW.example.com/a/?utm_x=1")
    assert m == "<!-- media-discovery:v1 url=https://example.com/a -->"
    assert urls_from_pr_bodies([m, "<!-- media-discovery:v1 url=ftp://example.com/ -->"]) == \
        {"https://example.com/a"}


def test_load_existing_reads_front_matter(tmp_path):
    (tmp_path / "_media").mkdir()
    (tmp_path / "_events").mkdir()
    (tmp_path / "_media" / "1-a.md").write_text(
        '---\ntitle: "Talk A"\narticle_url: "https://example.com/a"\n---\nbody\n')
    (tmp_path / "_media" / "2-bad.md").write_text("---\ntitle: [\n---\n")
    (tmp_path / "_media" / "3-none.md").write_text("no front matter")
    (tmp_path / "_events" / "e.md").write_text(
        "---\ntitle: Event B\nevent_url: https://example.org/e\n---\n")
    items = load_existing(tmp_path, CFG)
    assert ExistingItem("https://example.com/a", "Talk A") in items
    assert ExistingItem("https://example.org/e", "Event B") in items
    assert len(items) == 4  # malformed/missing front matter still yields a title-less item


def test_load_existing_missing_folders(tmp_path):
    assert load_existing(tmp_path, CFG) == []
