"""Tests for parsing, slugging, site settings, and newly-published detection."""

import subprocess

import pytest

import cross_post


CONFIG_TEXT = 'url: "https://adamdaniel.ai"\npermalink: /blog/:slug/\n'


def make_post(front_matter_lines, body="Some body text.\n"):
    fm = "\n".join(front_matter_lines)
    return f"---\n{fm}\n---\n{body}"


# --- parse_post -------------------------------------------------------


def test_parse_post_splits_front_matter_and_body():
    text = make_post(["title: Hello", "published: true"], body="Body here.\n")
    meta, body = cross_post.parse_post(text)
    assert meta == {"title": "Hello", "published": True}
    assert body == "Body here.\n"


def test_parse_post_missing_front_matter_returns_empty_meta():
    text = "Just a plain body, no front matter.\n"
    meta, body = cross_post.parse_post(text)
    assert meta == {}
    assert body == text


# --- slugify / slug_for -------------------------------------------------


def test_slugify_of_the_curly_quote_filename():
    name = "quoting-anthropic-opus-4-8-safety-“somewhat-less-robust”"
    assert cross_post.slugify(name) == "quoting-anthropic-opus-4-8-safety-somewhat-less-robust"


def test_slugify_collapses_non_word_runs_and_strips_edges():
    assert cross_post.slugify("  Hello, World!! ") == "hello-world"


def test_slug_for_derives_from_filename_when_no_front_matter_slug():
    path = "_posts/2026-05-28-quoting-anthropic-opus-4-8-safety-“somewhat-less-robust”.md"
    assert (
        cross_post.slug_for(path, {})
        == "quoting-anthropic-opus-4-8-safety-somewhat-less-robust"
    )


def test_front_matter_slug_wins():
    path = "_posts/2026-05-12-introducing-gha-bench.md"
    meta = {"slug": "custom-slug"}
    assert cross_post.slug_for(path, meta) == "custom-slug"


# --- site_settings / post_url -------------------------------------------


def test_site_settings_reads_url_and_permalink():
    settings = cross_post.site_settings(CONFIG_TEXT)
    assert settings.url == "https://adamdaniel.ai"
    assert settings.permalink == "/blog/:slug/"


def test_post_url_substitutes_slug():
    settings = cross_post.site_settings(CONFIG_TEXT)
    assert cross_post.post_url(settings, "my-slug") == "https://adamdaniel.ai/blog/my-slug/"


def test_permalink_other_than_slug_fails_loud():
    settings = cross_post.site_settings('url: "https://adamdaniel.ai"\npermalink: /blog/:year/:month/:slug/\n')
    with pytest.raises(SystemExit):
        cross_post.post_url(settings, "my-slug")


# --- is_published / is_fixture -------------------------------------------


def test_published_absent_counts_as_published():
    assert cross_post.is_published({}) is True


def test_published_false_is_not_published():
    assert cross_post.is_published({"published": False}) is False


def test_test_fixture_true_excluded():
    assert cross_post.is_fixture({"test_fixture": True}, "some-slug") is True


def test_e2e_slug_excluded():
    assert cross_post.is_fixture({}, "e2e-some-canary") is True


def test_non_fixture_non_e2e_not_excluded():
    assert cross_post.is_fixture({}, "a-real-post") is False


# --- newly_published -------------------------------------------------


def test_added_with_published_true():
    after = make_post(["title: New", "published: true"])
    assert cross_post.newly_published(None, after, "_posts/2026-01-01-new.md") is True


def test_flipped_false_to_true():
    before = make_post(["title: X", "published: false"])
    after = make_post(["title: X", "published: true"])
    assert cross_post.newly_published(before, after, "_posts/2026-01-01-x.md") is True


def test_edited_while_published_is_not_newly_published():
    before = make_post(["title: X", "published: true"], body="Old body.\n")
    after = make_post(["title: X", "published: true"], body="New body.\n")
    assert cross_post.newly_published(before, after, "_posts/2026-01-01-x.md") is False


def test_published_to_false_is_not_newly_published():
    before = make_post(["title: X", "published: true"])
    after = make_post(["title: X", "published: false"])
    assert cross_post.newly_published(before, after, "_posts/2026-01-01-x.md") is False


def test_deleted_is_not_newly_published():
    before = make_post(["title: X", "published: true"])
    assert cross_post.newly_published(before, None, "_posts/2026-01-01-x.md") is False


def test_published_absent_in_after_counts_as_published_for_newly_published():
    after = make_post(["title: New"])
    assert cross_post.newly_published(None, after, "_posts/2026-01-01-new.md") is True


def test_added_test_fixture_true_is_not_newly_published():
    after = make_post(["title: New", "published: true", "test_fixture: true"])
    assert cross_post.newly_published(None, after, "_posts/2026-01-01-new.md") is False


def test_added_e2e_slug_is_not_newly_published():
    after = make_post(["title: New", "published: true"])
    assert cross_post.newly_published(None, after, "_posts/2026-01-01-e2e-canary.md") is False


def test_2099_dated_canary_with_test_fixture_true_excluded():
    after = make_post(["title: Canary", "published: true", "test_fixture: true"])
    assert (
        cross_post.newly_published(None, after, "_posts/2099-12-31-future-canary.md")
        is False
    )


# --- detect_from_git -------------------------------------------------


class FakeRun:
    """Fake subprocess.run: dispatches on argv[1] (git subcommand)."""

    def __init__(self, diff_stdout, show_map):
        self.diff_stdout = diff_stdout
        self.show_map = show_map  # {(sha, path): text or None}
        self.calls = []

    def __call__(self, cmd, capture_output=True, text=True, **kwargs):
        self.calls.append(cmd)
        if cmd[1] == "diff":
            return subprocess.CompletedProcess(cmd, 0, stdout=self.diff_stdout, stderr="")
        if cmd[1] == "show":
            arg = cmd[2]
            sha, path = arg.split(":", 1)
            content = self.show_map.get((sha, path))
            if content is None:
                return subprocess.CompletedProcess(cmd, 128, stdout="", stderr="not found")
            return subprocess.CompletedProcess(cmd, 0, stdout=content, stderr="")
        raise AssertionError(f"unexpected git subcommand: {cmd}")


def test_zero_sha_before_returns_empty():
    fake = FakeRun(diff_stdout="", show_map={})
    result = cross_post.detect_from_git("0000000000000000000000000000000000000000", "after", run=fake)
    assert result == []
    assert fake.calls == []


def test_empty_before_returns_empty():
    fake = FakeRun(diff_stdout="", show_map={})
    result = cross_post.detect_from_git("", "after", run=fake)
    assert result == []


def test_detect_from_git_with_fake_run_finds_newly_published():
    before_sha = "before123"
    after_sha = "after456"
    diff_stdout = "A\t_posts/2026-01-01-added.md\nM\t_posts/2026-01-02-flipped.md\nM\t_posts/2026-01-03-edited.md\n"
    show_map = {
        (after_sha, "_posts/2026-01-01-added.md"): make_post(["title: Added", "published: true"]),
        (before_sha, "_posts/2026-01-02-flipped.md"): make_post(["title: Flip", "published: false"]),
        (after_sha, "_posts/2026-01-02-flipped.md"): make_post(["title: Flip", "published: true"]),
        (before_sha, "_posts/2026-01-03-edited.md"): make_post(["title: Edit", "published: true"], body="Old.\n"),
        (after_sha, "_posts/2026-01-03-edited.md"): make_post(["title: Edit", "published: true"], body="New.\n"),
    }
    fake = FakeRun(diff_stdout, show_map)
    result = cross_post.detect_from_git(before_sha, after_sha, run=fake)
    assert result == ["_posts/2026-01-01-added.md", "_posts/2026-01-02-flipped.md"]


def test_detect_from_git_integration_with_real_git_repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    run = subprocess.run

    def git(*args):
        return run(["git", *args], cwd=repo, capture_output=True, text=True, check=True)

    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")

    posts_dir = repo / "_posts"
    posts_dir.mkdir()
    post_path = posts_dir / "2026-01-01-added.md"
    post_path.write_text(make_post(["title: Added", "published: false"]), encoding="utf-8")
    git("add", "_posts/2026-01-01-added.md")
    git("commit", "-q", "-m", "add unpublished post")
    before_sha = run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()

    post_path.write_text(make_post(["title: Added", "published: true"]), encoding="utf-8")
    git("add", "_posts/2026-01-01-added.md")
    git("commit", "-q", "-m", "publish it")
    after_sha = run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()

    def run_in_repo(cmd, capture_output=True, text=True, **kwargs):
        return subprocess.run(cmd, cwd=repo, capture_output=capture_output, text=text, **kwargs)

    result = cross_post.detect_from_git(before_sha, after_sha, run=run_in_repo)
    assert result == ["_posts/2026-01-01-added.md"]
