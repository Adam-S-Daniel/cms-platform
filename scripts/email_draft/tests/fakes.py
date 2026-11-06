"""In-memory stand-ins for Fastmail's JMAP API and GitHub's REST API (HTTP transports).

Both implement just enough of the real protocols for the real `jmap.Jmap` and
`github_draft.GitHub` clients to run against them, and record every request so tests can assert
what was (and was not) written. Response bodies carry recognizable strings (SECRET_BODY) so the
log-leak test can prove no API response body reaches the log.
"""

from __future__ import annotations

import json
import re
from urllib.parse import unquote

SESSION_URL = "https://api.example.net/jmap/session"
API_URL = "https://api.example.net/jmap/api/"
DOWNLOAD = "https://api.example.net/jmap/download/{accountId}/{blobId}/{name}?accept={type}"
SECRET_BODY = "response-body-secret-4417"


class FakeFastmail:
    def __init__(self, raw: bytes, *, subject="A post from email", message_id="m1@example.com"):
        self.mailboxes = [
            {"id": "inbox", "name": "Inbox", "parentId": None, "role": "inbox"},
            {"id": "posting", "name": "Posting", "parentId": "inbox", "role": None},
            {"id": "drafts", "name": "Drafts", "parentId": None, "role": "drafts"},
            {"id": "sent", "name": "Sent", "parentId": None, "role": "sent"},
        ]
        self.identities = [
            {"id": "id-other", "email": "other@example.org", "name": "Other"},
            {"id": "id-owner", "email": "owner@example.com", "name": "Owner"},
            {"id": "id-posting", "email": "post-7f3a9c@example.net", "name": "Site"},
        ]
        self.emails = {
            "E1": {
                "id": "E1",
                "blobId": "B1",
                "mailboxIds": {"posting": True},
                "messageId": [message_id],
                "subject": subject,
                "receivedAt": "2026-11-06T14:55:04Z",
                "keywords": {},
            }
        }
        self.blobs = {"B1": raw}
        self.requests: list[tuple[str, str]] = []
        self.method_names: list[str] = []
        self.sent: list[dict] = []
        self.fail_http: dict[str, int] = {}  # method name or "session"/"download" -> status
        self._next = 0

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"].startswith("Bearer ")
        self.requests.append((method, url))
        if url.endswith("/jmap/session"):
            if "session" in self.fail_http:
                return self.fail_http["session"], SECRET_BODY.encode()
            return 200, json.dumps(
                {
                    "primaryAccounts": {"urn:ietf:params:jmap:mail": "acct1"},
                    "apiUrl": API_URL,
                    "downloadUrl": DOWNLOAD,
                }
            ).encode()
        if url.startswith("https://api.example.net/jmap/download/"):
            if "download" in self.fail_http:
                return self.fail_http["download"], SECRET_BODY.encode()
            blob = unquote(url.split("/")[6])
            return (200, self.blobs[blob]) if blob in self.blobs else (404, b"")
        assert url == API_URL and method == "POST"
        req = json.loads(body)
        assert "urn:ietf:params:jmap:submission" in req["using"]
        responses, created_ids = [], {}
        for name, args, call_id in req["methodCalls"]:
            self.method_names.append(name)
            if name in self.fail_http:
                return self.fail_http[name], SECRET_BODY.encode()
            responses.extend(self._method(name, args, call_id, created_ids))
        return 200, json.dumps({"methodResponses": responses}).encode()

    def _id(self, prefix):
        self._next += 1
        return f"{prefix}{self._next}"

    def _method(self, name, args, call_id, created_ids):
        if name == "Email/get":
            found = [self.emails[i] for i in args["ids"] if i in self.emails]
            return [[name, {"list": found, "notFound": []}, call_id]]
        if name == "Mailbox/get":
            return [[name, {"list": self.mailboxes}, call_id]]
        if name == "Identity/get":
            return [[name, {"list": self.identities}, call_id]]
        if name == "Mailbox/set":
            created = {}
            for key, box in args.get("create", {}).items():
                new = {"id": self._id("mb"), "role": None, **box}
                self.mailboxes.append(new)
                created[key] = {"id": new["id"]}
            return [[name, {"created": created}, call_id]]
        if name == "Email/set":
            out = {"created": {}, "updated": {}}
            for key, em in args.get("create", {}).items():
                new_id = self._id("R")
                self.emails[new_id] = {"id": new_id, **em}
                created_ids[key] = new_id
                out["created"][key] = {"id": new_id}
            for eid, patch in args.get("update", {}).items():
                self._patch(self.emails[eid], patch)
                out["updated"][eid] = None
            return [[name, out, call_id]]
        if name == "EmailSubmission/set":
            out = {"created": {}}
            implicit = {"updated": {}}
            for key, sub in args.get("create", {}).items():
                eid = sub["emailId"]
                eid = created_ids[eid[1:]] if eid.startswith("#") else eid
                ident = next(i for i in self.identities if i["id"] == sub["identityId"])
                self.sent.append({"email": self.emails[eid], "identity": ident})
                out["created"][key] = {"id": self._id("S")}
                patch = args.get("onSuccessUpdateEmail", {}).get("#" + key)
                if patch:
                    self._patch(self.emails[eid], patch)
                    implicit["updated"][eid] = None
            return [[name, out, call_id], ["Email/set", implicit, call_id]]
        raise AssertionError(f"unexpected JMAP method {name}")

    @staticmethod
    def _patch(target, patch):
        for path, value in patch.items():
            parts = path.split("/")
            if len(parts) == 1:
                target[path] = value
                continue
            bucket = target.setdefault(parts[0], {})
            if value is None:
                bucket.pop(parts[1], None)
            else:
                bucket[parts[1]] = value


class FakeGitHubApi:
    def __init__(self, *, pulls=None):
        self.pulls = list(pulls or [])
        self.branches = {"main": "headsha"}
        self.files: set[str] = set()
        self.calls: list[tuple[str, str, dict | None]] = []
        self.fail: dict[str, int] = {}  # "<METHOD> <path regex>" -> status
        self._n = 0

    def __call__(self, method, url, headers, body):
        assert headers["Authorization"].startswith("Bearer ")
        path = url.split("/repos/example-owner/example-site", 1)[1]
        payload = json.loads(body) if body else None
        self.calls.append((method, path, payload))
        for pattern, status in self.fail.items():
            m, p = pattern.split(" ", 1)
            if m == method and re.search(p, path):
                return status, json.dumps({"message": SECRET_BODY}).encode()
        return self._route(method, path, payload)

    def ok(self, data, status=200):
        return status, json.dumps(data).encode()

    def _route(self, method, path, payload):
        if method == "GET" and path.startswith("/pulls?"):
            return self.ok(self.pulls)
        if method == "GET" and path == "":
            return self.ok({"default_branch": "main"})
        if method == "GET" and path.startswith("/git/ref/heads/"):
            name = unquote(path[len("/git/ref/heads/") :])
            if name in self.branches:
                return self.ok({"object": {"sha": self.branches[name]}})
            return 404, json.dumps({"message": "Not Found"}).encode()
        if method == "GET" and path.startswith("/git/commits/"):
            return self.ok({"tree": {"sha": "treesha"}})
        if method == "GET" and path.startswith("/contents/"):
            name = unquote(path[len("/contents/") :].split("?")[0])
            return self.ok({}) if name in self.files else (404, b"{}")
        self._n += 1
        if method == "POST" and path == "/git/blobs":
            return self.ok({"sha": f"blob{self._n}"}, 201)
        if method == "POST" and path == "/git/trees":
            return self.ok({"sha": f"tree{self._n}"}, 201)
        if method == "POST" and path == "/git/commits":
            return self.ok({"sha": f"commit{self._n}"}, 201)
        if method == "POST" and path == "/git/refs":
            self.branches[payload["ref"][len("refs/heads/") :]] = payload["sha"]
            return self.ok({"ref": payload["ref"]}, 201)
        if method == "POST" and path == "/pulls":
            return self.ok({"number": 42}, 201)
        if method == "POST" and re.fullmatch(r"/issues/\d+/labels", path):
            return self.ok([{"name": n} for n in payload["labels"]])
        raise AssertionError(f"unexpected GitHub call {method} {path}")

    def writes(self):
        return [(m, p) for m, p, _ in self.calls if m != "GET"]
