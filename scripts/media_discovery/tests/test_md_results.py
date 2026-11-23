"""findings.json: ids, reasons and the merge rules (pure), the GitHub contents
calls, and how a run uses them. Fictional people and example.* hosts only."""

import base64
import copy
import json
from datetime import datetime

import pytest
from md_fixtures import CFG, make_candidate, page
from test_md_cli import (CONFIRMED, ENV, MONTH_ONLY_EVENT, PAGES, UNCONFIRMED, FakeGitHub,
                         Harness, main)

from media_discovery.corroborate import Problem
from media_discovery.github_api import GitHub, GitHubError
from media_discovery.render import render_entry
from media_discovery.results import build_finding, finding_id, merge_results

NOW1, NOW2 = "2026-11-02T13:00:00Z", "2026-11-09T13:00:00Z"
PERSON = "Pat Rivera"


# ── ids ────────────────────────────────────────────────────────────────────

def test_finding_id_is_stable_and_ignores_tracking_noise():
    a = finding_id("https://www.Example.com/talk/?utm_source=x&b=2&a=1#frag")
    assert a == finding_id("https://example.com/talk?a=1&b=2")
    assert len(a) == 16 and int(a, 16) >= 0
    assert a != finding_id("https://example.com/other")


def test_finding_id_falls_back_to_the_raw_url_when_it_cannot_be_normalized():
    assert finding_id("  ftp://x.example.com/a ") == finding_id("ftp://x.example.com/a")
    assert finding_id("ftp://x.example.com/a") != finding_id("ftp://x.example.com/b")


# ── build_finding ─────────────────────────────────────────────────────────

def test_a_confirmed_finding_has_the_pages_shape_and_no_reasons():
    cand = make_candidate()
    entry = render_entry(cand, "past_talk", CFG)
    f = build_finding(cand, "past_talk", "confirmed", [], entry, {}, PERSON)
    assert f == {
        "id": finding_id(cand.primary_url), "status": "confirmed", "kind": "past_talk",
        "title": cand.title, "outlet": cand.outlet, "date": cand.date, "end_date": None,
        "primary_url": cand.primary_url, "other_urls": cand.supporting_urls, "reasons": [],
        "entry": {"collection": "media", "slug": entry.slug, "path": entry.path,
                  "content": entry.content}}


def test_reasons_carry_bare_predicates_whole_problems_and_other_page_titles():
    cand = make_candidate(supporting_urls=["https://news.example.org/recap"])
    problems = [
        Problem("identity", cand.primary_url, "no-name"),
        Problem("no-match", "https://news.example.org/recap"),
        Problem("not-fetched", "https://gone.example.org/x"),
        Problem("no-second-source"),
        Problem("weird-code", "https://news.example.org/recap"),  # no wording: dropped
    ]
    titles = {cand.primary_url: "Main Title", "https://news.example.org/recap": "Recap Page"}
    f = build_finding(cand, "past_talk", "unconfirmed", problems, None, titles, PERSON)
    assert f["entry"] is None and f["status"] == "unconfirmed"
    main_, other, unread, whole = f["reasons"]
    assert main_ == {"url": cand.primary_url, "main": True, "code": "identity",
                     "detail": "no-name",
                     "text": "doesn't show Pat Rivera's name. It may only be in a video or image."}
    assert "title" not in main_  # a title is recorded for other pages only
    assert other["title"] == "Recap Page" and other["main"] is False
    assert other["text"].startswith("mentions Pat Rivera")
    assert "title" not in unread and unread["text"] == "wasn't checked."
    assert whole == {"url": "", "main": False, "code": "no-second-source", "detail": "",
                     "text": "Only one website backed it up, and the search needs two "
                             "separate ones.", "whole": True}


def test_an_empty_title_is_not_recorded():
    cand = make_candidate()
    f = build_finding(cand, "past_talk", "unconfirmed",
                      [Problem("no-match", "https://news.example.org/recap")], None,
                      {"https://news.example.org/recap": ""}, PERSON)
    assert "title" not in f["reasons"][0]


# ── merge_results ─────────────────────────────────────────────────────────

def finding(url, status="confirmed", **kw):
    cand = make_candidate(primary_url=url, title=kw.pop("title", "T " + url[-3:]))
    entry = render_entry(cand, "past_talk", CFG) if status == "confirmed" or kw.pop("entry", 0) \
        else None
    problems = [] if status == "confirmed" else [Problem("no-second-source")]
    return build_finding(cand, "past_talk", status, problems, entry, {}, PERSON)


A, B, C, D = (f"https://a.example.com/{n}" for n in "abcd")


def test_no_prior_adds_everything_and_emails_it():
    run = [finding(A), finding(B, "unconfirmed")]
    doc, new = merge_results(None, None, run, now=NOW1, person=PERSON)
    assert [f["id"] for f in doc["findings"]] == [f["id"] for f in run]
    assert [f["id"] for f in new] == [f["id"] for f in run]
    assert doc["version"] == 1 and doc["searched_at"] == NOW1 and doc["person"] == PERSON
    assert all(f["first_seen"] == f["last_seen"] == NOW1 for f in doc["findings"])


def test_confirmed_and_decided_findings_are_not_emailed_again():
    prior, _ = merge_results(None, None, [finding(A), finding(B, "unconfirmed")],
                             now=NOW1, person=PERSON)
    ida, idb = finding_id(A), finding_id(B)
    decisions = {"version": 1, "decisions": {idb: {"decision": "skipped", "at": NOW1}}}
    snapshot = copy.deepcopy(prior)
    doc, new = merge_results(prior, decisions, [finding(A), finding(B, "unconfirmed")],
                             now=NOW2, person=PERSON)
    assert new == []
    by = {f["id"]: f for f in doc["findings"]}
    assert by[ida]["last_seen"] == by[idb]["last_seen"] == NOW2
    assert by[ida]["first_seen"] == NOW1
    assert prior == snapshot  # the input is never mutated


def test_a_decided_unconfirmed_find_is_not_upgraded_or_emailed():
    prior, _ = merge_results(None, None, [finding(B, "unconfirmed")], now=NOW1, person=PERSON)
    decisions = {"decisions": {finding_id(B): {"decision": "added"}}}
    doc, new = merge_results(prior, decisions, [finding(B)], now=NOW2, person=PERSON)
    assert new == [] and doc["findings"][0]["status"] == "unconfirmed"
    assert doc["findings"][0]["last_seen"] == NOW2


def test_still_unconfirmed_refreshes_reasons_without_an_email():
    prior, _ = merge_results(None, None, [finding(B, "unconfirmed")], now=NOW1, person=PERSON)
    again = finding(B, "unconfirmed")
    again["reasons"] = [{"url": "", "main": False, "code": "x", "detail": "", "text": "new",
                         "whole": True}]
    doc, new = merge_results(prior, None, [again], now=NOW2, person=PERSON)
    assert new == []
    [f] = doc["findings"]
    assert f["reasons"][0]["text"] == "new" and f["last_seen"] == NOW2
    assert f["first_seen"] == NOW1 and f["status"] == "unconfirmed"


def test_unconfirmed_then_confirmed_is_upgraded_and_emailed_as_ready():
    prior, _ = merge_results(None, None, [finding(B, "unconfirmed")], now=NOW1, person=PERSON)
    doc, new = merge_results(prior, None, [finding(B)], now=NOW2, person=PERSON)
    [f] = doc["findings"]
    assert f["status"] == "confirmed" and f["reasons"] == [] and f["entry"]["collection"] == "media"
    assert f["first_seen"] == NOW1 and f["last_seen"] == NOW2
    assert [n["id"] for n in new] == [f["id"]] and new[0]["status"] == "confirmed"


def test_prior_findings_not_seen_are_kept_and_touched_ones_get_last_seen():
    prior, _ = merge_results(None, None, [finding(A), finding(B), finding(C, "unconfirmed")],
                             now=NOW1, person=PERSON)
    doc, new = merge_results(prior, None, [finding(D)], now=NOW2, person=PERSON,
                             touched={finding_id(A)})
    by = {f["id"]: f for f in doc["findings"]}
    assert [n["id"] for n in new] == [finding_id(D)]
    assert by[finding_id(A)]["last_seen"] == NOW2
    assert by[finding_id(B)]["last_seen"] == by[finding_id(C)]["last_seen"] == NOW1
    assert len(doc["findings"]) == 4


def test_the_same_id_twice_in_a_run_lists_once_and_prefers_confirmed():
    doc, new = merge_results(None, None, [finding(A, "unconfirmed"), finding(A)],
                             now=NOW1, person=PERSON)
    assert len(doc["findings"]) == 1 and doc["findings"][0]["status"] == "confirmed"
    assert len(new) == 1


# ── GitHub contents calls ─────────────────────────────────────────────────

class Transport:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, method, url, headers, body):
        path = url.removeprefix("https://api.github.com")
        self.calls.append((method, path, json.loads(body) if body else None))
        result = self.routes[(method, path)]
        if isinstance(result, list):
            return result.pop(0)
        return result


def enc(obj):
    return base64.b64encode(json.dumps(obj).encode()).decode()


def test_read_json_returns_data_and_sha_and_404_is_none():
    t = Transport({
        ("GET", "/repos/o/r/contents/findings.json?ref=persistent%2Fmedia-search"):
            (200, {"sha": "s1", "content": enc({"version": 1, "findings": []}) + "\n"}),
        ("GET", "/repos/o/r/contents/decisions.json?ref=persistent%2Fmedia-search"): (404, None),
    })
    gh = GitHub("t", transport=t)
    assert gh.read_json("o/r", "persistent/media-search", "findings.json") == (
        {"version": 1, "findings": []}, "s1")
    assert gh.read_json("o/r", "persistent/media-search", "decisions.json") == (None, None)


def test_read_json_of_junk_is_none_with_its_sha_and_other_errors_raise_templates_only():
    t = Transport({
        ("GET", "/repos/o/r/contents/f.json?ref=b"): (200, {"sha": "s", "content": "!!notjson"}),
        ("GET", "/repos/o/r/contents/secret-name.json?ref=b"): (500, None),
    })
    gh = GitHub("t", transport=t)
    assert gh.read_json("o/r", "b", "f.json") == (None, "s")
    with pytest.raises(GitHubError) as exc:
        gh.read_json("o/r", "b", "secret-name.json")
    assert exc.value.status == 500
    assert "secret-name" not in str(exc.value)
    assert exc.value.endpoint == "GET /repos/{repo}/contents/{path}"


def test_read_json_over_1mb_is_fetched_raw():
    big = {"version": 1, "findings": [{"id": "a"}]}
    calls = []

    def t(method, url, headers, body):
        calls.append(headers["Accept"])
        if headers["Accept"] == "application/vnd.github.raw+json":
            return 200, big
        return 200, {"sha": "s", "content": "", "encoding": "none", "size": 2_000_000}

    gh = GitHub("t", transport=t)
    assert gh.read_json("o/r", "b", "findings.json") == (big, "s")
    assert calls == ["application/vnd.github+json", "application/vnd.github.raw+json"]


def test_write_json_creates_without_a_sha_and_updates_with_one():
    t = Transport({("PUT", "/repos/o/r/contents/findings.json"):
                   [(201, {"content": {"sha": "n1"}}), (200, {"content": {"sha": "n2"}})]})
    gh = GitHub("t", transport=t)
    data = {"version": 1, "title": "Café"}
    assert gh.write_json("o/r", "persistent/media-search", "findings.json", data, None, "msg") == "n1"
    assert gh.write_json("o/r", "persistent/media-search", "findings.json", data, "n1", "msg") == "n2"
    first, second = t.calls[0][2], t.calls[1][2]
    assert "sha" not in first and second["sha"] == "n1"
    assert first["branch"] == "persistent/media-search" and first["message"] == "msg"
    assert json.loads(base64.b64decode(first["content"]).decode("utf-8")) == data


def test_a_stale_sha_write_is_a_github_error_without_the_path():
    t = Transport({("PUT", "/repos/o/r/contents/findings.json"): (409, None)})
    with pytest.raises(GitHubError) as exc:
        GitHub("t", transport=t).write_json("o/r", "b", "findings.json", {}, "old", "m")
    assert exc.value.status == 409
    assert exc.value.endpoint == "PUT /repos/{repo}/contents/{path}"


def test_ensure_branch_creates_it_from_the_default_branch_only_when_missing():
    t = Transport({
        ("GET", "/repos/o/r/git/ref/heads/persistent%2Fmedia-search"): [(404, None), (200, {})],
        ("GET", "/repos/o/r"): (200, {"default_branch": "main"}),
        ("GET", "/repos/o/r/git/ref/heads/main"): (200, {"object": {"sha": "a" * 40}}),
        ("POST", "/repos/o/r/git/refs"): (201, {}),
    })
    gh = GitHub("t", transport=t)
    assert gh.ensure_branch("o/r", "persistent/media-search") is True
    assert t.calls[-1][2] == {"ref": "refs/heads/persistent/media-search", "sha": "a" * 40}
    n = len(t.calls)
    assert gh.ensure_branch("o/r", "persistent/media-search") is False
    assert len(t.calls) == n + 1  # just the existence check


def test_ensure_branch_on_an_empty_repository_is_an_error():
    t = Transport({
        ("GET", "/repos/o/r/git/ref/heads/b"): (404, None),
        ("GET", "/repos/o/r"): (200, {"default_branch": "main"}),
        ("GET", "/repos/o/r/git/ref/heads/main"): (404, None),
    })
    with pytest.raises(GitHubError) as exc:
        GitHub("t", transport=t).ensure_branch("o/r", "b")
    assert exc.value.status == 404


# ── A run, end to end, with a fake results repository ────────────────────

RES_TOKEN = "ghs-results"


class FakeResultsRepo(FakeGitHub):
    """The results repository's contents, keyed by path -> (data, sha)."""

    def __init__(self, token, files=None, read_error=None, write_errors=()):
        super().__init__(token)
        self.files = dict(files or {})
        self.read_error, self.write_errors = read_error, list(write_errors)
        self.reads, self.writes, self.branches = [], [], []
        self.counter = 0

    def read_json(self, repo, branch, path):
        self.reads.append((repo, branch, path))
        if self.read_error:
            raise self.read_error
        data, sha = self.files.get(path, (None, None))
        return copy.deepcopy(data), sha

    def ensure_branch(self, repo, branch):
        self.branches.append((repo, branch))
        return False

    def write_json(self, repo, branch, path, data, sha, message):
        if self.write_errors:
            err = self.write_errors.pop(0)
            if err:
                raise err
        self.writes.append(dict(repo=repo, branch=branch, path=path, data=copy.deepcopy(data),
                                sha=sha, message=message))
        self.counter += 1
        self.files[path] = (copy.deepcopy(data), f"sha{self.counter}")
        return f"sha{self.counter}"


class ResultsHarness(Harness):
    def __init__(self, site, *, files=None, read_error=None, write_errors=(), extra_pages=None,
                 env_extra=None, titles=None, **kw):
        env = dict(ENV)
        env["MEDIA_DISCOVERY_RESULTS_TOKEN"] = RES_TOKEN
        env.update(env_extra or {})
        super().__init__(site, env=env, **kw)
        self.results = FakeResultsRepo(RES_TOKEN, files, read_error, write_errors)
        self.extra_pages, self.titles = extra_pages or {}, titles or {}
        self.factory_tokens = []
        plain_fetch = self.browser.fetch

        def browser_fetch(url):  # the real browser reads the title too
            got = plain_fetch(url)
            got.title = self.titles.get(url, "")
            return got
        self.browser.fetch = browser_fetch

    def github(self, token):
        self.factory_tokens.append(token)
        return self.results if token == RES_TOKEN else super().github(token)

    def fetch(self, url):
        self.fetched.append(url)
        text = self.extra_pages.get(url, PAGES.get(url))
        status = 200 if text is not None else 404
        got = page(url, text or "", status)
        got.title = self.titles.get(url, "")
        return got

    def run(self, *extra, mode="email-only", now=NOW1):
        self.code = main(["run", "--site-root", str(self.site), "--repo", "owner/site",
                          "--mode", mode, "--today", "2026-11-02", *extra],
                         env=self.env, client_factory=lambda key: self.client,
                         fetcher=self.fetch, github_factory=self.github, send=self.send,
                         out=self.out, browser_factory=lambda: self.browser,
                         clock=lambda: datetime.fromisoformat(now.replace("Z", "+00:00")))
        self.stdout = self.out.getvalue()
        return self

    @property
    def doc(self):
        return self.results.writes[-1]["data"]

    def by_url(self):
        return {f["primary_url"]: f for f in self.doc["findings"]}


def test_first_run_writes_the_results_file_and_emails_everything(site):
    h = ResultsHarness(site).run()
    assert h.code == 0
    assert h.results.writes[0]["path"] == "findings.json"
    assert h.results.writes[0]["repo"] == "owner/site"
    assert h.results.writes[0]["branch"] == "persistent/media-search"
    assert h.results.branches == [("owner/site", "persistent/media-search")]
    assert h.doc["searched_at"] == NOW1 and h.doc["person"] == "Pat Rivera"
    by = h.by_url()
    assert by[CONFIRMED["primary_url"]]["status"] == "confirmed"
    assert by[CONFIRMED["primary_url"]]["entry"]["slug"] == "1-open-data-in-practice"
    lonely = by[UNCONFIRMED["primary_url"]]
    assert lonely["status"] == "unconfirmed" and lonely["reasons"][0]["whole"] is True
    assert lonely["entry"] is not None  # a draft could be made for it
    forum = by[MONTH_ONLY_EVENT["primary_url"]]
    assert forum["entry"] is None and forum["reasons"][0]["code"] == "no-entry"
    [(subject, _, _)] = h.sent
    assert subject.startswith("site.example.com new mentions: 1 to add, 2 to double-check")
    assert "repeats=0 results_written=1" in h.stdout
    # The PR token and the results token are different credentials.
    assert set(h.factory_tokens) == {"ghs-test", RES_TOKEN}
    h.assert_counts_only()
    for f in h.doc["findings"]:
        assert f["id"] not in h.stdout


def seeded(site, **kw):
    """A harness whose results repo holds what a first run wrote."""
    first = ResultsHarness(site).run()
    return ResultsHarness(site, files={"findings.json": first.results.files["findings.json"]}, **kw)


def test_second_run_repeats_nothing_and_sends_no_email(site):
    h = seeded(site).run(now=NOW2)
    assert h.code == 0 and h.sent == []
    assert "nothing new; no email" in h.stdout
    assert "repeats=1 results_written=1" in h.stdout
    # The confirmed repeat is skipped before fetching; unconfirmed ones are re-checked.
    assert CONFIRMED["primary_url"] not in h.fetched
    assert UNCONFIRMED["primary_url"] in h.fetched
    by = h.by_url()
    assert by[CONFIRMED["primary_url"]]["last_seen"] == NOW2
    assert by[CONFIRMED["primary_url"]]["first_seen"] == NOW1
    assert h.doc["searched_at"] == NOW2
    h.assert_counts_only()


def test_a_decided_find_is_skipped_before_fetching(site):
    first = ResultsHarness(site).run()
    lonely = {f["primary_url"]: f["id"] for f in first.doc["findings"]}[UNCONFIRMED["primary_url"]]
    h = ResultsHarness(site, files={
        "findings.json": first.results.files["findings.json"],
        "decisions.json": ({"version": 1, "decisions": {lonely: {"decision": "skipped",
                                                                "at": NOW1}}}, "d1")})
    h.run(now=NOW2)
    assert UNCONFIRMED["primary_url"] not in h.fetched
    assert "repeats=2" in h.stdout and h.sent == []


def test_an_unconfirmed_find_that_now_checks_out_is_upgraded_and_emailed(site):
    upgraded = {**UNCONFIRMED, "supporting_urls": ["https://other.example.org/x"]}
    extra = {"https://other.example.org/x":
             "Lonely Claim 2026 is confirmed here: Pat Rivera, Northwind Legal. " + "foxtrot " * 30}
    first = ResultsHarness(site, candidates=[UNCONFIRMED]).run()
    assert first.by_url()[UNCONFIRMED["primary_url"]]["status"] == "unconfirmed"
    h = ResultsHarness(site, candidates=[upgraded], extra_pages=extra,
                       files={"findings.json": first.results.files["findings.json"]})
    h.run(now=NOW2)
    f = h.by_url()[UNCONFIRMED["primary_url"]]
    assert f["status"] == "confirmed" and f["reasons"] == [] and f["entry"]
    assert f["first_seen"] == NOW1 and f["last_seen"] == NOW2
    [(subject, body, _)] = h.sent
    assert subject == "site.example.com new mentions: 1 to add (preview)"
    assert "Lonely Claim" in body and "COULDN'T CONFIRM" not in body


def test_without_a_results_token_no_file_is_read_or_written(site):
    h = Harness(site, env=dict(ENV)).run(mode="email-only")
    assert h.code == 0 and "results_written=0" in h.stdout and "repeats=0" in h.stdout
    assert len(h.sent) == 1


def test_a_failed_read_is_a_fixed_notice_and_the_run_carries_on(site):
    h = ResultsHarness(site, read_error=GitHubError(403, "GET /repos/{repo}/contents/{path}"))
    h.run()
    assert h.code == 0 and h.results.writes == []
    assert "::notice::earlier results could not be read (HTTP 403)" in h.stdout
    assert "results_written=0" in h.stdout
    assert len(h.sent) == 1  # nothing known, so everything is emailed as before


def test_a_malformed_results_file_is_left_alone(site):
    h = ResultsHarness(site, files={"findings.json": ({"findings": "nope"}, "s")}).run()
    assert h.results.writes == [] and "not in the expected shape" in h.stdout
    assert h.code == 0


def test_an_existing_unreadable_results_file_is_not_overwritten(site):
    h = ResultsHarness(site, files={"findings.json": (None, "s")}).run()
    assert h.results.writes == [] and "not in the expected shape" in h.stdout
    assert h.code == 0


def test_a_stale_sha_is_re_read_merged_again_and_retried_once(site):
    first = ResultsHarness(site).run()
    stale = first.results.files["findings.json"]
    h = ResultsHarness(site, files={"findings.json": (stale[0], "old")},
                       write_errors=[GitHubError(409, "PUT /repos/{repo}/contents/{path}")])
    # Someone else wrote in between: the re-read finds the newer file and sha.
    newer = copy.deepcopy(stale[0])
    newer["findings"] = [f for f in newer["findings"]
                         if f["primary_url"] != UNCONFIRMED["primary_url"]]
    reads = h.results.read_json

    def read_json(repo, branch, path):
        if path == "findings.json" and any(r[2] == "findings.json" for r in h.results.reads):
            h.results.files["findings.json"] = (newer, "new")
        return reads(repo, branch, path)
    h.results.read_json = read_json
    h.run(now=NOW2)
    [write] = h.results.writes
    assert write["sha"] == "new" and "results_written=1" in h.stdout
    assert UNCONFIRMED["primary_url"] in {f["primary_url"] for f in write["data"]["findings"]}
    # Merged against the newer file, so the find it lacked is new, hence emailed.
    assert "Lonely Claim" in h.sent[0][1]


def test_a_second_refused_write_gives_up_with_a_notice_and_still_emails(site):
    err = GitHubError(409, "PUT /repos/{repo}/contents/{path}")
    h = ResultsHarness(site, write_errors=[err, err]).run()
    assert h.code == 0 and h.results.writes == []
    assert "results file could not be written" in h.stdout and "results_written=0" in h.stdout
    assert len(h.sent) == 1


def test_another_write_error_is_not_retried(site):
    h = ResultsHarness(site, write_errors=[GitHubError(403, "PUT /repos/{repo}/contents/{path}")])
    h.run()
    assert h.code == 0 and "results_written=0" in h.stdout
    assert [r for r in h.results.reads if r[2] == "findings.json"] == [
        ("owner/site", "persistent/media-search", "findings.json")]


def test_results_repo_and_branch_come_from_the_environment(site):
    h = ResultsHarness(site, env_extra={"MEDIA_DISCOVERY_RESULTS_REPO": "owner/results",
                                        "MEDIA_DISCOVERY_RESULTS_BRANCH": "persistent/other"})
    h.run()
    assert h.results.writes[0]["repo"] == "owner/results"
    assert h.results.writes[0]["branch"] == "persistent/other"


def test_a_bad_results_repo_is_a_notice(site):
    h = ResultsHarness(site, env_extra={"MEDIA_DISCOVERY_RESULTS_REPO": "not-a-slug"}).run()
    assert "MEDIA_DISCOVERY_RESULTS_REPO must be OWNER/NAME" in h.stdout
    assert h.results.writes == [] and h.code == 0


def test_page_titles_reach_other_page_reasons_and_never_the_log(site):
    primary, other = "https://t.example.com/a", "https://t2.example.org/b"
    cand = {**CONFIRMED, "title": "Titled Claim", "primary_url": primary,
            "supporting_urls": [other]}
    extra = {primary: "Titled Claim 2026: Pat Rivera, Northwind Legal. " + "golf " * 30,
             other: "Titled Claim 2026 and nothing else on this page. " + "hotel " * 30}
    h = ResultsHarness(site, candidates=[cand], extra_pages=extra,
                       titles={primary: "Main Page Secret", other: "Other Page Secret"})
    h.run()
    f = h.by_url()[primary]
    assert f["status"] == "unconfirmed"
    reasons = {r["url"]: r for r in f["reasons"] if r["url"]}
    assert reasons[other]["title"] == "Other Page Secret" and reasons[other]["main"] is False
    assert "Secret" not in h.stdout and "t.example" not in h.stdout
    h.assert_counts_only()
