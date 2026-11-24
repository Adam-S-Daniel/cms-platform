import base64
import json

import pytest
from md_fixtures import CFG, make_candidate

from media_discovery.dedupe import pr_marker
from media_discovery.github_api import GitHub, GitHubError, OpenedPR
from media_discovery.render import render_entry


class Transport:
    """Routes (METHOD, path-without-host) to (status, data); records every call."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, method, url, headers, body):
        path = url.removeprefix("https://api.github.com")
        self.calls.append((method, path, headers, json.loads(body) if body else None))
        result = self.routes.get((method, path))
        if result is None:
            raise AssertionError(f"unexpected call {method} {path}")
        return result(path) if callable(result) else result


def pr(number, body, *labels):
    return {"number": number, "body": body, "labels": [{"name": n} for n in labels]}


def test_prior_pr_urls_paginates_and_filters_by_label():
    page1 = [pr(i, pr_marker(f"https://a.example.com/{i}"), "media-discovery") for i in range(99)]
    page1.append(pr(99, pr_marker("https://a.example.com/unlabeled"), "other"))
    page2 = [pr(100, pr_marker("https://b.example.org/x?utm_source=y"), "media-discovery",
                "decap-cms/pending_review"),
             pr(101, None, "media-discovery")]
    t = Transport({
        ("GET", "/repos/o/r/pulls?state=all&per_page=100&page=1"): (200, page1),
        ("GET", "/repos/o/r/pulls?state=all&per_page=100&page=2"): (200, page2),
    })
    urls = GitHub("tok", transport=t).prior_pr_urls("o/r")
    assert len(urls) == 100
    assert "https://b.example.org/x" in urls
    assert "https://a.example.com/unlabeled" not in urls
    assert len(t.calls) == 2
    method, _, headers, _ = t.calls[0]
    assert headers["Authorization"] == "Bearer tok" and method == "GET"


def test_default_branch_sha():
    t = Transport({
        ("GET", "/repos/o/r"): (200, {"default_branch": "main"}),
        ("GET", "/repos/o/r/git/ref/heads/main"): (200, {"object": {"sha": "a" * 40}}),
    })
    assert GitHub("t", transport=t).default_branch_sha("o/r") == ("main", "a" * 40)


def entry():
    # An event: the plain branch-and-file path. Media takes the placement path.
    return render_entry(make_candidate(kind="upcoming_talk"), "upcoming_talk", CFG)


def media_entry(date="2026-03-12"):
    return render_entry(make_candidate(kind="podcast", date=date), "podcast", CFG)


def full_routes(over=None):
    e = entry()
    routes = {
        ("GET", "/repos/o/r"): (200, {"default_branch": "main"}),
        ("GET", "/repos/o/r/git/ref/heads/main"): (200, {"object": {"sha": "b" * 40}}),
        ("POST", "/repos/o/r/git/refs"): (201, {}),
        ("PUT", f"/repos/o/r/contents/{e.path}"): (201, {}),
        ("POST", "/repos/o/r/pulls"): (201, {"number": 7,
                                              "html_url": "https://github.example.com/o/r/pull/7"}),
        ("POST", "/repos/o/r/issues/7/labels"): (200, []),
        ("POST", "/repos/o/r/pulls/7/requested_reviewers"): (201, {}),
    }
    routes.update(over or {})
    return routes


def test_open_entry_pr_creates_branch_file_pr_labels_reviewers():
    e = entry()
    t = Transport(full_routes())
    out = GitHub("t", transport=t).open_entry_pr(
        "o/r", e, "Create Media “x”", "body", ["decap-cms/pending_review", "media-discovery"],
        ["editor-one"])
    assert out == OpenedPR(7, "https://github.example.com/o/r/pull/7", True)
    calls = {(m, p): payload for m, p, _, payload in t.calls}
    assert calls[("POST", "/repos/o/r/git/refs")] == {
        "ref": "refs/heads/cms/events/2026-03-12-open-data-in-practice", "sha": "b" * 40}
    put = calls[("PUT", "/repos/o/r/contents/_events/2026-03-12-open-data-in-practice.md")]
    assert put["branch"] == e.branch
    assert base64.b64decode(put["content"]).decode() == e.content
    assert calls[("POST", "/repos/o/r/pulls")] == {
        "title": "Create Media “x”", "body": "body", "head": e.branch, "base": "main"}
    assert calls[("POST", "/repos/o/r/issues/7/labels")] == {
        "labels": ["decap-cms/pending_review", "media-discovery"]}
    assert calls[("POST", "/repos/o/r/pulls/7/requested_reviewers")] == {"reviewers": ["editor-one"]}
    assert [m for m, *_ in t.calls] == ["GET", "GET", "POST", "PUT", "POST", "POST", "POST"]


def test_no_reviewers_means_no_reviewer_call():
    t = Transport(full_routes())
    GitHub("t", transport=t).open_entry_pr("o/r", entry(), "T", "B", ["media-discovery"], [])
    assert not any(p.endswith("requested_reviewers") for _, p, *_ in t.calls)


def test_existing_branch_returns_none():
    t = Transport(full_routes({("POST", "/repos/o/r/git/refs"): (422, {"message": "exists"})}))
    assert GitHub("t", transport=t).open_entry_pr("o/r", entry(), "T", "B", [], []) is None
    assert not any(m == "PUT" for m, *_ in t.calls)


def test_existing_file_deletes_the_new_branch_and_returns_none():
    e = entry()
    t = Transport(full_routes({
        ("PUT", f"/repos/o/r/contents/{e.path}"): (422, None),
        ("DELETE", f"/repos/o/r/git/refs/heads/{e.branch}"): (204, None),
    }))
    assert GitHub("t", transport=t).open_entry_pr("o/r", e, "T", "B", [], []) is None
    assert t.calls[-1][0] == "DELETE"
    assert not any(p == "/repos/o/r/pulls" for _, p, *_ in t.calls)


def test_refused_reviewer_is_reported_not_raised():
    t = Transport(full_routes({("POST", "/repos/o/r/pulls/7/requested_reviewers"): (422, None)}))
    out = GitHub("t", transport=t).open_entry_pr("o/r", entry(), "T", "B", [], ["someone"])
    assert out.reviewers_requested is False and out.number == 7


def test_errors_carry_status_and_endpoint_template_only():
    secret_body = {"message": "Pat Rivera's private note", "documentation_url": "x"}
    t = Transport(full_routes({("POST", "/repos/o/r/pulls"): (403, secret_body)}))
    with pytest.raises(GitHubError) as info:
        GitHub("t", transport=t).open_entry_pr("o/r", entry(), "T", "B", [], [])
    err = info.value
    assert (err.status, err.endpoint) == (403, "POST /repos/{repo}/pulls")
    assert str(err) == "GitHub API POST /repos/{repo}/pulls returned HTTP 403"
    assert "Pat" not in str(err) and "open-data" not in str(err)


def test_transport_exception_becomes_status_0_without_its_message():
    def boom(*a):
        raise OSError("connection to secret.example.com failed")
    with pytest.raises(GitHubError) as info:
        GitHub("t", transport=boom).default_branch_sha("o/r")
    assert info.value.status == 0 and "secret" not in str(info.value)
    assert info.value.__cause__ is None and info.value.__suppress_context__


def test_bad_repo_is_rejected():
    with pytest.raises(ValueError):
        GitHub("t", transport=Transport({})).default_branch_sha("no-slash")


def item(weight, date, category="Podcasts & Interviews"):
    return f"---\ncategory: \"{category}\"\ndate_display: \"{date}\"\nweight: {weight}\n---\n"


def media_routes(files, e):
    """files: {name: content}. Routes for the placement path."""
    listing = [{"type": "file", "name": n, "path": f"_media/{n}", "sha": f"sha-{n}"}
               for n in files]
    routes = {
        ("GET", "/repos/o/r"): (200, {"default_branch": "main"}),
        ("GET", "/repos/o/r/git/ref/heads/main"): (200, {"object": {"sha": "b" * 40}}),
        ("GET", f"/repos/o/r/contents/_media?ref={'b' * 40}"): (200, listing),
        ("GET", f"/repos/o/r/git/commits/{'b' * 40}"): (200, {"tree": {"sha": "t" * 40}}),
        ("POST", "/repos/o/r/git/trees"): (201, {"sha": "n" * 40}),
        ("POST", "/repos/o/r/git/commits"): (201, {"sha": "c" * 40}),
        ("POST", "/repos/o/r/git/refs"): (201, {}),
        ("POST", "/repos/o/r/pulls"): (201, {"number": 7,
                                              "html_url": "https://github.example.com/o/r/pull/7"}),
    }
    for n, text in files.items():
        routes[("GET", f"/repos/o/r/git/blobs/sha-{n}")] = (
            200, {"content": base64.b64encode(text.encode()).decode()})
    return routes


def test_media_entry_is_placed_before_the_first_older_item_in_one_commit():
    e = media_entry("2026-03-12")  # "March 2026"
    files = {"1-new.md": item(1, "October 2026"), "2-old.md": item(2, "May 2025"),
             "3-older.md": item(3, "2020"), "1-other.md": item(1, "May 2010", "Press Coverage")}
    t = Transport(media_routes(files, e))
    out = GitHub("t", transport=t).open_entry_pr("o/r", e, "T", "B", [], [])
    assert out is not None and out.number == 7
    calls = {(m, p): payload for m, p, _, payload in t.calls}
    tree = calls[("POST", "/repos/o/r/git/trees")]
    assert tree["base_tree"] == "t" * 40
    got = {x["path"]: x["content"] for x in tree["tree"]}
    assert set(got) == {e.path, "_media/2-old.md", "_media/3-older.md"}
    assert "weight: 2\n" in got[e.path] and "weight: 1" not in got[e.path]
    assert got["_media/2-old.md"] == item(3, "May 2025")
    assert got["_media/3-older.md"] == item(4, "2020")
    assert calls[("POST", "/repos/o/r/git/commits")] == {
        "message": "T", "tree": "n" * 40, "parents": ["b" * 40]}
    assert calls[("POST", "/repos/o/r/git/refs")] == {
        "ref": f"refs/heads/{e.branch}", "sha": "c" * 40}
    assert not any(m == "PUT" for m, *_ in t.calls)


def test_media_entry_older_than_everything_goes_last_and_moves_nothing():
    e = media_entry("2010-01-05")
    files = {"1-a.md": item(1, "May 2026"), "2-b.md": item(2, "2020")}
    t = Transport(media_routes(files, e))
    GitHub("t", transport=t).open_entry_pr("o/r", e, "T", "B", [], [])
    tree = next(p for m, path, _, p in t.calls if path == "/repos/o/r/git/trees")
    assert [x["path"] for x in tree["tree"]] == [e.path]
    assert "weight: 3\n" in tree["tree"][0]["content"]


def test_media_file_already_on_the_default_branch_returns_none_without_a_commit():
    e = media_entry()
    t = Transport(media_routes({"1-open-data-in-practice.md": item(1, "March 2026")}, e))
    assert GitHub("t", transport=t).open_entry_pr("o/r", e, "T", "B", [], []) is None
    assert not any(p.endswith("/git/commits") and m == "POST" for m, p, *_ in t.calls)


def test_media_existing_branch_returns_none():
    e = media_entry()
    routes = media_routes({"1-a.md": item(1, "May 2026")}, e)
    routes[("POST", "/repos/o/r/git/refs")] = (422, {"message": "exists"})
    t = Transport(routes)
    assert GitHub("t", transport=t).open_entry_pr("o/r", e, "T", "B", [], []) is None
    assert not any(p == "/repos/o/r/pulls" for _, p, *_ in t.calls)
