"""Tests for the cross_post CLI (main())."""

import json
import subprocess

import cross_post


CONFIG_TEXT = 'url: "https://adamdaniel.ai"\npermalink: /blog/:slug/\n'


def read_outputs(path):
    outputs = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        key, _, value = line.partition("=")
        outputs[key] = value
    return outputs


def make_post_file(dir_path, filename, front_matter_lines, body="Body text.\n"):
    posts_dir = dir_path / "_posts"
    posts_dir.mkdir(exist_ok=True)
    fm = "\n".join(front_matter_lines)
    (posts_dir / filename).write_text(f"---\n{fm}\n---\n{body}", encoding="utf-8")
    return f"_posts/{filename}"


def test_cli_detect_with_post_flag_on_fixture_post_gives_count_zero(tmp_path, monkeypatch):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    path = make_post_file(
        tmp_path,
        "2026-01-01-e2e-fixture.md",
        ["title: Fixture", "published: true", "test_fixture: true"],
    )
    monkeypatch.chdir(tmp_path)
    github_output = tmp_path / "gh_output.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    out_dir = tmp_path / "out"

    rc = cross_post.main(["detect", "--post", path, "--out", str(out_dir)])

    assert rc in (0, None)
    outputs = read_outputs(github_output)
    assert outputs["count"] == "0"
    assert outputs["changed"] == "false"
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))
    assert posts == []


def test_cli_detect_with_post_flag_on_published_post_gives_count_one(tmp_path, monkeypatch):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    path = make_post_file(
        tmp_path,
        "2026-01-01-real-post.md",
        ["title: Real Post", "published: true"],
    )
    monkeypatch.chdir(tmp_path)
    github_output = tmp_path / "gh_output.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    out_dir = tmp_path / "out"

    cross_post.main(["detect", "--post", path, "--out", str(out_dir)])

    outputs = read_outputs(github_output)
    assert outputs["count"] == "1"
    assert outputs["changed"] == "true"
    posts = json.loads((out_dir / "posts.json").read_text(encoding="utf-8"))
    assert len(posts) == 1
    assert posts[0]["slug"] == "real-post"
    assert posts[0]["url"] == "https://adamdaniel.ai/blog/real-post/"


def test_cli_detect_with_before_after_shas(tmp_path, monkeypatch):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    def git(*args):
        return subprocess.run(["git", *args], cwd=tmp_path, capture_output=True, text=True, check=True)

    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")

    make_post_file(tmp_path, "2026-01-01-new-post.md", ["title: New Post", "published: true"])
    git("add", "-A")
    git("commit", "-q", "-m", "add new post")
    after_sha = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=tmp_path, capture_output=True, text=True, check=True
    ).stdout.strip()
    before_sha = subprocess.run(
        ["git", "rev-parse", "HEAD~0"], cwd=tmp_path, capture_output=True, text=True
    )
    # Use the zero SHA as "before" to simulate a first push -- must yield nothing.
    zero_sha = "0" * 40

    github_output = tmp_path / "gh_output.txt"
    monkeypatch.setenv("GITHUB_OUTPUT", str(github_output))
    out_dir = tmp_path / "out"
    cross_post.main(["detect", "--before", zero_sha, "--after", after_sha, "--out", str(out_dir)])
    outputs = read_outputs(github_output)
    assert outputs["count"] == "0"
    assert outputs["changed"] == "false"


def test_cli_render_reads_posts_json_and_writes_outputs(tmp_path, monkeypatch):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    path = make_post_file(
        tmp_path,
        "2026-01-01-render-post.md",
        ["title: Render Post", "excerpt: An excerpt.", "published: true"],
        body="Full body text.\n",
    )
    monkeypatch.chdir(tmp_path)
    out_dir = tmp_path / "out"

    cross_post.main(["detect", "--post", path, "--out", str(out_dir)])
    cross_post.main(["render", "--out", str(out_dir), "--max-chars", "500"])

    status_file = out_dir / "render-post.status.txt"
    substack_file = out_dir / "render-post.substack.md"
    meta_file = out_dir / "render-post.meta.json"
    assert status_file.exists()
    assert substack_file.exists()
    assert meta_file.exists()
    assert "Render Post" in status_file.read_text(encoding="utf-8")


def test_cli_post_mastodon_no_token(tmp_path, monkeypatch, capsys):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    path = make_post_file(
        tmp_path,
        "2026-01-01-mastodon-post.md",
        ["title: Mastodon Post", "published: true"],
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("MASTODON_ACCESS_TOKEN", raising=False)
    out_dir = tmp_path / "out"

    cross_post.main(["detect", "--post", path, "--out", str(out_dir)])
    cross_post.main(["post-mastodon", "--instance", "https://mastodon.example", "--out", str(out_dir)])

    captured = capsys.readouterr()
    assert "MASTODON_ACCESS_TOKEN is not set" in captured.out


def test_cli_post_linkedin_no_token(tmp_path, monkeypatch, capsys):
    (tmp_path / "_config.yml").write_text(CONFIG_TEXT, encoding="utf-8")
    path = make_post_file(
        tmp_path,
        "2026-01-01-linkedin-post.md",
        ["title: LinkedIn Post", "published: true"],
    )
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("LINKEDIN_ACCESS_TOKEN", raising=False)
    monkeypatch.delenv("LINKEDIN_TOKEN_MINTED", raising=False)
    out_dir = tmp_path / "out"

    cross_post.main(["detect", "--post", path, "--out", str(out_dir)])
    rc = cross_post.main(["post-linkedin", "--out", str(out_dir)])

    assert rc == 0
    captured = capsys.readouterr()
    assert "::warning::LinkedIn leg skipped: LINKEDIN_ACCESS_TOKEN is not set" in captured.out
    assert not (out_dir / "linkedin-post.linkedin.json").exists()


def test_cli_check_linkedin_token_fresh_with_today(monkeypatch, capsys):
    monkeypatch.setenv("LINKEDIN_TOKEN_MINTED", "2026-09-01")
    rc = cross_post.main(["check-linkedin-token", "--today", "2026-09-22"])
    assert rc == 0
    assert "::notice::LinkedIn access token is 21 days old; expires in 39 days" in capsys.readouterr().out


def test_cli_check_linkedin_token_expired_with_today(monkeypatch, capsys):
    monkeypatch.setenv("LINKEDIN_TOKEN_MINTED", "2026-07-01")
    rc = cross_post.main(["check-linkedin-token", "--today", "2026-09-22"])
    assert rc == 1
    assert "::error::LinkedIn access token expired (minted 2026-07-01, 83 days ago)" in capsys.readouterr().out


def test_cli_check_linkedin_token_unset(monkeypatch, capsys):
    monkeypatch.delenv("LINKEDIN_TOKEN_MINTED", raising=False)
    rc = cross_post.main(["check-linkedin-token", "--today", "2026-09-22"])
    assert rc == 1
    assert "::error::LINKEDIN_TOKEN_MINTED is not set" in capsys.readouterr().out
