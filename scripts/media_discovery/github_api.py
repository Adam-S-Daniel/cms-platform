"""The few GitHub REST calls discovery makes, over urllib.

Errors carry only the HTTP status and an endpoint TEMPLATE such as
"POST /repos/{repo}/pulls": a response body, a branch name or a file path can
hold a find's title, and the repository and its Actions logs are public.
"""

import base64
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from urllib.parse import quote

from .dedupe import urls_from_pr_bodies
from .render import Entry

API = "https://api.github.com"
PER_PAGE = 100
MAX_PAGES = 100
USER_AGENT = "cms-platform-media-discovery/1"


class GitHubError(Exception):
    def __init__(self, status: int, endpoint: str):
        super().__init__(f"GitHub API {endpoint} returned HTTP {status}")
        self.status = status
        self.endpoint = endpoint


@dataclass(frozen=True)
class OpenedPR:
    number: int
    url: str
    reviewers_requested: bool


def urllib_transport(method: str, url: str, headers: dict, body: bytes | None):
    """(status, parsed JSON or None). Never raises for an HTTP status."""
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, b""
        err.close()
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, None


class GitHub:
    def __init__(self, token: str, *, transport=urllib_transport, api: str = API):
        self._token = token
        self._transport = transport
        self._api = api.rstrip("/")

    def _call(self, method: str, path: str, endpoint: str, payload=None, ok=(200, 201)):
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": USER_AGENT,
        }
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        try:
            status, data = self._transport(method, self._api + path, headers, body)
        except Exception:  # noqa: BLE001 - re-raised without its message
            raise GitHubError(0, endpoint) from None
        if status not in ok:
            raise GitHubError(status, endpoint)
        return status, data

    @staticmethod
    def _repo(repo: str) -> str:
        owner, _, name = repo.partition("/")
        if not owner or not name or "/" in name:
            raise ValueError("repo must be OWNER/NAME")
        return f"{quote(owner, safe='')}/{quote(name, safe='')}"

    def prior_pr_urls(self, repo: str, label: str = "media-discovery") -> set[str]:
        """Source URLs named in every PR (open or closed) carrying `label`."""
        r = self._repo(repo)
        bodies = []
        for page in range(1, MAX_PAGES + 1):
            _, data = self._call(
                "GET", f"/repos/{r}/pulls?state=all&per_page={PER_PAGE}&page={page}",
                "GET /repos/{repo}/pulls")
            data = data or []
            bodies += [pr.get("body") or "" for pr in data
                       if any(lb.get("name") == label for lb in pr.get("labels") or [])]
            if len(data) < PER_PAGE:
                break
        return urls_from_pr_bodies(bodies)

    def default_branch_sha(self, repo: str) -> tuple[str, str]:
        """(default branch name, its head commit sha)."""
        r = self._repo(repo)
        _, info = self._call("GET", f"/repos/{r}", "GET /repos/{repo}")
        branch = info["default_branch"]
        _, ref = self._call("GET", f"/repos/{r}/git/ref/heads/{quote(branch, safe='')}",
                            "GET /repos/{repo}/git/ref/heads/{branch}")
        return branch, ref["object"]["sha"]

    def open_entry_pr(self, repo: str, entry: Entry, title: str, body: str,
                      labels: list[str], reviewers: list[str]) -> OpenedPR | None:
        """Branch, file, PR, labels and reviewers, shaped like a Decap
        editorial-workflow entry. None when the branch or file already exists
        (an earlier run or an editor got there first)."""
        r = self._repo(repo)
        base, sha = self.default_branch_sha(repo)
        status, _ = self._call("POST", f"/repos/{r}/git/refs", "POST /repos/{repo}/git/refs",
                               {"ref": f"refs/heads/{entry.branch}", "sha": sha},
                               ok=(201, 422))
        if status == 422:
            return None
        status, _ = self._call(
            "PUT", f"/repos/{r}/contents/{quote(entry.path, safe='/')}",
            "PUT /repos/{repo}/contents/{path}",
            {"message": title, "branch": entry.branch,
             "content": base64.b64encode(entry.content.encode("utf-8")).decode("ascii")},
            ok=(200, 201, 422))
        if status == 422:  # the file is already on the default branch
            self._call("DELETE", f"/repos/{r}/git/refs/heads/{quote(entry.branch, safe='/')}",
                       "DELETE /repos/{repo}/git/refs/heads/{branch}", ok=(204, 422))
            return None
        _, pr = self._call("POST", f"/repos/{r}/pulls", "POST /repos/{repo}/pulls",
                           {"title": title, "body": body, "head": entry.branch, "base": base})
        number = pr["number"]
        if labels:
            self._call("POST", f"/repos/{r}/issues/{number}/labels",
                       "POST /repos/{repo}/issues/{number}/labels", {"labels": labels})
        requested = True
        if reviewers:
            # The PR exists by now, so a refused reviewer (not a collaborator,
            # or the token's own identity) is reported, not fatal.
            status, _ = self._call(
                "POST", f"/repos/{r}/pulls/{number}/requested_reviewers",
                "POST /repos/{repo}/pulls/{number}/requested_reviewers",
                {"reviewers": reviewers}, ok=(200, 201, 422))
            requested = status != 422
        return OpenedPR(number, pr["html_url"], requested)
