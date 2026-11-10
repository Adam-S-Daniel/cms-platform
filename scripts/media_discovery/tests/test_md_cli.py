"""End-to-end runs of `python3 -m media_discovery run` with every dependency faked."""

import io
from types import SimpleNamespace

import pytest
from md_fixtures import CONFIG_YAML, PAGE_A, PAGE_B, page

from media_discovery.__main__ import main
from media_discovery.dedupe import pr_marker
from media_discovery.github_api import GitHubError, OpenedPR

CONFIRMED = {
    "kind": "past_talk", "title": "Open Data in Practice", "outlet": "Example Summit",
    "date": "2026-03-12", "end_date": None, "location": None, "session": None,
    "primary_url": "https://events.example.com/talks/open-data",
    "supporting_urls": ["https://news.example.org/summit-recap"],
    "evidence": [], "reasoning": "Bio matches.",
}
DUPLICATE = {**CONFIRMED, "title": "Already Listed Interview", "kind": "podcast",
             "primary_url": "https://pod.example.com/ep1", "supporting_urls": []}
EARLIER_PR = {**CONFIRMED, "title": "Proposed Last Week", "kind": "press",
              "primary_url": "https://paper.example.com/story", "supporting_urls": []}
UNCONFIRMED = {**CONFIRMED, "title": "Lonely Claim", "kind": "press",
               "primary_url": "https://solo.example.com/claim",
               "supporting_urls": ["https://solo.example.com/other"]}
MONTH_ONLY_EVENT = {**CONFIRMED, "kind": "upcoming_talk", "title": "Data Futures Forum",
                    "date": "2026-12", "primary_url": "https://forum.example.com/2026",
                    "supporting_urls": ["https://press.example.org/forum"]}
BAD = {"kind": "nonsense"}

FORUM = ("Data Futures Forum 2026 speakers include Pat Rivera of Northwind Legal. "
         + "charlie " * 30)
FORUM_PRESS = ("Announced today: Data Futures Forum, December 2026, with Pat Rivera, "
               "Northwind Legal. " + "delta " * 30)
SOLO = "Lonely Claim 2026: Pat Rivera, Northwind Legal. " + "echo " * 30

PAGES = {
    CONFIRMED["primary_url"]: PAGE_A,
    CONFIRMED["supporting_urls"][0]: PAGE_B,
    UNCONFIRMED["primary_url"]: SOLO,
    UNCONFIRMED["supporting_urls"][0]: SOLO,
    MONTH_ONLY_EVENT["primary_url"]: FORUM,
    MONTH_ONLY_EVENT["supporting_urls"][0]: FORUM_PRESS,
}

# Strings that must never reach stdout: titles, names, URLs, addresses, outlets.
PRIVATE = ["Open Data", "Lonely", "Forum", "Pat", "Rivera", "Northwind", "example.com",
           "example.org", "Summit", "@", "Already Listed", "Proposed Last Week"]

ENV = {
    "ANTHROPIC_API_KEY": "sk-test",
    "GITHUB_TOKEN": "ghs-test",
    "MEDIA_DISCOVERY_SMTP_USER": "bot@example.com",
    "MEDIA_DISCOVERY_SMTP_PASSWORD": "pw",
    "MEDIA_DISCOVERY_MAIL_TO": "owner@example.com, editor@example.net",
    "MEDIA_DISCOVERY_REVIEWERS": "editor-one, editor-two",
    "MEDIA_DISCOVERY_ADMIN_URL": "https://site.example.com/admin/",
    "MEDIA_DISCOVERY_SITE_NAME": "Example Site",
}


@pytest.fixture
def site(tmp_path):
    (tmp_path / ".github").mkdir()
    (tmp_path / ".github" / "media-discovery.yml").write_text(CONFIG_YAML, encoding="utf-8")
    (tmp_path / "_media").mkdir()
    (tmp_path / "_media" / "1-old.md").write_text(
        '---\ntitle: "Already Listed Interview"\narticle_url: "https://elsewhere.example.com/x"\n'
        "---\n", encoding="utf-8")
    return tmp_path


def message(payload, stop="tool_use"):
    block = SimpleNamespace(type="tool_use", id="toolu_1", name="submit_candidates", input=payload)
    return SimpleNamespace(stop_reason=stop, content=[block])


class FakeClient:
    def __init__(self, msg=None, error=None):
        self.msg, self.error, self.calls = msg, error, []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw):
        self.calls.append(kw)
        if self.error:
            raise self.error
        msg = self.msg

        class S:
            def __enter__(self):
                return self

            def __exit__(self, *e):
                return False

            def get_final_message(self):
                return msg
        return S()


class FakeGitHub:
    def __init__(self, token, prior=(), error=None, list_error=None):
        self.token, self.prior, self.error = token, set(prior), error
        self.list_error = list_error
        self.opened = []

    def prior_pr_urls(self, repo):
        if self.list_error:
            raise self.list_error
        return set(self.prior)

    def open_entry_pr(self, repo, entry, title, body, labels, reviewers):
        if self.error:
            raise self.error
        self.opened.append(dict(repo=repo, entry=entry, title=title, body=body, labels=labels,
                                reviewers=reviewers))
        return OpenedPR(len(self.opened), f"https://github.example.com/o/r/pull/{len(self.opened)}",
                        True)


class Harness:
    def __init__(self, site, *, candidates=None, env=None, client=None, gh_error=None,
                 list_error=None):
        self.site = site
        payload = {"candidates": candidates if candidates is not None else
                   [CONFIRMED, DUPLICATE, EARLIER_PR, UNCONFIRMED, MONTH_ONLY_EVENT, BAD]}
        self.client = client or FakeClient(message(payload))
        self.env = dict(ENV if env is None else env)
        self.gh = None
        self.gh_error = gh_error
        self.list_error = list_error
        self.fetched = []
        self.sent = []
        self.out = io.StringIO()

    def github(self, token):
        self.gh = FakeGitHub(token, prior={"https://paper.example.com/story"}, error=self.gh_error,
                             list_error=self.list_error)
        return self.gh

    def fetch(self, url):
        self.fetched.append(url)
        return page(url, PAGES.get(url, ""), 200 if url in PAGES else 404)

    def send(self, subject, body, **kw):
        self.sent.append((subject, body, kw))

    def run(self, *extra, mode="live"):
        self.code = main(["run", "--site-root", str(self.site), "--repo", "owner/site",
                          "--mode", mode, "--today", "2026-11-02", *extra],
                         env=self.env, client_factory=lambda key: self.client,
                         fetcher=self.fetch, github_factory=self.github, send=self.send,
                         out=self.out)
        self.stdout = self.out.getvalue()
        return self

    def assert_counts_only(self):
        for word in PRIVATE:
            assert word not in self.stdout, f"stdout leaked {word!r}:\n{self.stdout}"


def test_live_run_opens_one_pr_and_emails_the_digest(site):
    h = Harness(site).run()
    assert h.code == 0
    assert ("media-discovery: mode=live candidates=5 dropped=1 duplicates=2 confirmed=1 "
            "prs_opened=1 unconfirmed=2") in h.stdout
    h.assert_counts_only()

    [pr] = h.gh.opened
    assert h.gh.token == "ghs-test" and pr["repo"] == "owner/site"
    assert pr["entry"].branch == "cms/media/1-open-data-in-practice"
    assert pr["labels"] == ["decap-cms/pending_review", "media-discovery"]
    assert pr["reviewers"] == ["editor-one", "editor-two"]
    assert pr["body"].startswith(pr_marker(CONFIRMED["primary_url"]))
    assert "<https://site.example.com/admin/#/workflow>" in pr["body"]

    # Duplicates are never fetched; every other candidate's URLs are.
    assert "https://pod.example.com/ep1" not in h.fetched
    assert "https://paper.example.com/story" not in h.fetched
    assert set(PAGES) <= set(h.fetched)

    [(subject, body, kw)] = h.sent
    assert subject == "1 new find for Example Site to review"
    assert "https://github.example.com/o/r/pull/1" in body
    assert "Lonely Claim" in body and "no independent second source" in body
    assert "Data Futures Forum" in body and "an event needs a full YYYY-MM-DD date" in body
    assert kw == dict(host="smtp.fastmail.com", port=465, user="bot@example.com", password="pw",
                      mail_from="bot@example.com",
                      mail_to=["owner@example.com", "editor@example.net"])
    assert "digest emailed to 2 recipient(s)" in h.stdout


def test_today_and_the_existing_items_reach_the_model(site):
    h = Harness(site).run()
    content = h.client.calls[0]["messages"][0]["content"]
    assert "2026-11-02" in content and "Already Listed Interview" in content


def test_email_only_lists_would_open_and_opens_nothing(site):
    h = Harness(site).run(mode="email-only")
    assert h.code == 0
    assert "mode=email-only" in h.stdout and "prs_opened=0" in h.stdout
    assert h.gh.opened == []
    [(subject, body, _)] = h.sent
    assert subject == "1 confirmed find for Example Site (email-only mode)"
    assert "Would add: _media/1-open-data-in-practice.md" in body
    h.assert_counts_only()


def test_live_without_a_token_falls_back_to_email_only(site):
    env = {k: v for k, v in ENV.items() if k != "GITHUB_TOKEN"}
    h = Harness(site, env=env).run()
    assert h.code == 0 and h.gh is None
    assert "live mode needs GITHUB_TOKEN" in h.stdout and "mode=email-only" in h.stdout
    assert "(email-only mode)" in h.sent[0][0]


def test_unconfigured_site_is_a_no_op(tmp_path):
    h = Harness(tmp_path, client=FakeClient(error=AssertionError("must not be called"))).run()
    assert h.code == 0
    assert "::notice::media discovery is not configured for this site" in h.stdout
    assert h.client.calls == [] and h.sent == [] and h.gh is None


def test_missing_api_key_names_the_knob_and_passes(site):
    env = {k: v for k, v in ENV.items() if k != "ANTHROPIC_API_KEY"}
    h = Harness(site, env=env).run()
    assert h.code == 0 and h.client.calls == []
    assert "MEDIA_DISCOVERY_ANTHROPIC_API_KEY repository secret" in h.stdout


def test_invalid_config_fails(site):
    (site / ".github" / "media-discovery.yml").write_text("person: [", encoding="utf-8")
    h = Harness(site).run()
    assert h.code == 1 and "::error::.github/media-discovery.yml is invalid" in h.stdout


def test_missing_smtp_knobs_are_named_not_failed(site):
    env = {k: v for k, v in ENV.items() if k not in ("MEDIA_DISCOVERY_SMTP_PASSWORD",
                                                       "MEDIA_DISCOVERY_MAIL_TO")}
    h = Harness(site, env=env).run()
    assert h.code == 0 and h.sent == []
    assert ("::notice::digest not emailed: set MEDIA_DISCOVERY_SMTP_PASSWORD, "
            "MEDIA_DISCOVERY_MAIL_TO") in h.stdout


def test_no_email_flag(site):
    h = Harness(site).run("--no-email")
    assert h.code == 0 and h.sent == [] and "--no-email set" in h.stdout


def test_nothing_found_sends_nothing(site):
    h = Harness(site, candidates=[]).run()
    assert h.code == 0 and h.sent == [] and "nothing new; no email" in h.stdout


def test_api_error_fails_with_a_sanitized_message(site):
    class APIStatusError(Exception):
        status_code = 529
    err = APIStatusError("overloaded: Pat Rivera https://example.com")
    h = Harness(site, client=FakeClient(error=err)).run()
    assert h.code == 1
    assert "::error::the Claude API request failed (APIStatusError, HTTP 529)" in h.stdout
    h.assert_counts_only()


def test_refusal_is_a_warning_not_a_failure(site):
    h = Harness(site, client=FakeClient(message({"candidates": [CONFIRMED]}, stop="refusal"))).run()
    assert h.code == 0 and "::warning::the model declined the request" in h.stdout
    assert "candidates=0" in h.stdout


def test_github_error_still_emails_then_fails(site):
    h = Harness(site, gh_error=GitHubError(403, "POST /repos/{repo}/pulls")).run()
    assert h.code == 1
    assert "::error::GitHub API POST /repos/{repo}/pulls returned HTTP 403" in h.stdout
    [(_, body, _)] = h.sent
    assert "the pull request could not be opened (HTTP 403)" in body
    h.assert_counts_only()


def test_a_crashing_candidate_does_not_abort_the_run(site):
    h = Harness(site, candidates=[CONFIRMED, UNCONFIRMED])
    real = h.fetch

    def fetch(url):
        if url == UNCONFIRMED["primary_url"]:
            raise RuntimeError("boom Pat Rivera https://solo.example.com/claim")
        return real(url)
    h.fetch = fetch
    h.run()
    assert h.code == 0
    assert "unconfirmed=1" in h.stdout and "prs_opened=1" in h.stdout
    [(_, body, _)] = h.sent
    assert "internal error while checking" in body
    assert "boom" not in h.stdout and "Traceback" not in h.stdout
    h.assert_counts_only()


def test_smtp_error_fails_without_quoting_it(site):
    def send(*a, **kw):
        raise OSError("550 owner@example.com rejected")
    h = Harness(site)
    h.send = send
    h.run()
    assert h.code == 1 and "::error::sending the digest failed (OSError)" in h.stdout
    h.assert_counts_only()


def test_a_refused_smtp_login_prints_the_redacted_server_replies(site):
    from media_discovery.mailer import SMTPLoginError

    def send(*a, **kw):
        raise SMTPLoginError(["server: smtp.fastmail.com port 465 (implicit TLS)",
                              "AUTH PLAIN: 535 5.7.8 Authentication failed"])
    h = Harness(site)
    h.send = send
    h.run()
    assert h.code == 1
    assert "media-discovery: smtp AUTH PLAIN: 535 5.7.8 Authentication failed" in h.stdout
    assert "::error::sending the digest failed (SMTPLoginError" in h.stdout
    h.assert_counts_only()


def test_mail_from_overrides_the_from_address_only(site):
    h = Harness(site, env={**ENV, "MEDIA_DISCOVERY_MAIL_FROM": " alerts@example.com "}).run()
    [(_, _, kw)] = h.sent
    assert kw["mail_from"] == "alerts@example.com" and kw["user"] == "bot@example.com"
    assert "::warning::" not in h.stdout


def test_mail_from_unset_or_blank_uses_the_smtp_user(site):
    for env in (ENV, {**ENV, "MEDIA_DISCOVERY_MAIL_FROM": "  "}):
        h = Harness(site, env=env).run()
        [(_, _, kw)] = h.sent
        assert kw["mail_from"] == "bot@example.com" and "MAIL_FROM" not in h.stdout


@pytest.mark.parametrize("bad", ["a@example.com, b@example.com", "not-an-address",
                                 "Name <a@example.com>, <b@example.com>", "a b@example.com"])
def test_invalid_mail_from_falls_back_and_is_never_printed(site, bad):
    h = Harness(site, env={**ENV, "MEDIA_DISCOVERY_MAIL_FROM": bad}).run()
    [(_, _, kw)] = h.sent
    assert h.code == 0 and kw["mail_from"] == "bot@example.com"
    assert ("::warning::MEDIA_DISCOVERY_MAIL_FROM is not a single email address; "
            "sending from the SMTP login") in h.stdout
    assert bad not in h.stdout and "a@example.com" not in h.stdout


def test_bad_repo_argument(site):
    out = io.StringIO()
    code = main(["run", "--site-root", str(site), "--repo", "nope", "--mode", "live"],
                env=ENV, out=out)
    assert code == 2 and "OWNER/NAME" in out.getvalue()


def test_unlistable_prior_prs_fail_a_live_run(site):
    h = Harness(site, list_error=GitHubError(403, "GET /repos/{repo}/pulls")).run()
    assert h.code == 1 and "::error::GitHub API GET /repos/{repo}/pulls returned HTTP 403" in h.stdout
    assert h.client.calls == [] and h.sent == []


def test_unlistable_prior_prs_are_a_notice_in_email_only_mode(site):
    h = Harness(site, list_error=GitHubError(403, "GET /repos/{repo}/pulls")).run(mode="email-only")
    assert h.code == 0 and "could not be listed" in h.stdout
    # Without the PR check the earlier-proposed find is no longer a duplicate.
    assert "duplicates=1" in h.stdout and len(h.sent) == 1
    h.assert_counts_only()
