"""The few Fastmail JMAP calls email-to-draft needs (RFC 8620 core, RFC 8621 mail/submission).

Every HTTP call goes through an injectable `transport(method, url, headers, body)` returning
`(status, bytes)`. Errors carry only a call name and an HTTP status or JMAP error type, never a
response body, so they are safe to log.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

SESSION_URL = "https://api.fastmail.com/jmap/session"
CORE = "urn:ietf:params:jmap:core"
MAIL = "urn:ietf:params:jmap:mail"
SUBMISSION = "urn:ietf:params:jmap:submission"
USING = [CORE, MAIL, SUBMISSION]
EMAIL_PROPERTIES = ["blobId", "mailboxIds", "messageId", "subject", "receivedAt", "keywords"]


class JmapError(Exception):
    def __init__(self, what: str, detail: str):
        super().__init__(f"{what}: {detail}")
        self.what = what
        self.detail = detail


def urllib_transport(method, url, headers, body):
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read() if exc.fp else b""


class Jmap:
    def __init__(self, token: str, transport=None, session_url: str = SESSION_URL):
        self.token = token
        self.transport = transport or urllib_transport
        self.session_url = session_url
        self.account_id = self.api_url = self.download_url = None

    def _http(self, method, url, body=None, what="http"):
        headers = {"Authorization": f"Bearer {self.token}", "Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        status, raw = self.transport(method, url, headers, body)
        if status != 200:
            raise JmapError(what, f"HTTP {status}")
        return raw

    def session(self) -> None:
        raw = self._http("GET", self.session_url, what="session")
        try:
            data = json.loads(raw)
            self.account_id = data["primaryAccounts"][MAIL]
            self.api_url = data["apiUrl"]
            self.download_url = data["downloadUrl"]
        except (ValueError, KeyError, TypeError) as exc:
            raise JmapError("session", "malformed session") from exc

    def call(self, method_calls: list, what: str) -> dict:
        """Run the calls; return {call id: arguments}. Any JMAP method error raises."""
        body = json.dumps({"using": USING, "methodCalls": method_calls}).encode("utf-8")
        raw = self._http("POST", self.api_url, body, what=what)
        try:
            responses = json.loads(raw)["methodResponses"]
        except (ValueError, KeyError, TypeError) as exc:
            raise JmapError(what, "malformed response") from exc
        out = {}
        for name, args, call_id in responses:
            if name == "error":
                raise JmapError(what, f"method error {args.get('type', 'unknown')}")
            out.setdefault(call_id, args)  # an implicit Email/set reuses the call id
        return out

    # ---- reads ---------------------------------------------------------

    def get_email(self, email_id: str) -> dict:
        res = self.call(
            [
                [
                    "Email/get",
                    {
                        "accountId": self.account_id,
                        "ids": [email_id],
                        "properties": EMAIL_PROPERTIES,
                    },
                    "g",
                ]
            ],
            "Email/get",
        )
        found = res["g"].get("list") or []
        if not found:
            raise JmapError("Email/get", "not found")
        return found[0]

    def download(self, blob_id: str) -> bytes:
        url = (
            self.download_url.replace("{accountId}", urllib.parse.quote(self.account_id, safe=""))
            .replace("{blobId}", urllib.parse.quote(blob_id, safe=""))
            .replace("{type}", urllib.parse.quote("message/rfc822", safe=""))
            .replace("{name}", "message.eml")
        )
        return self._http("GET", url, what="download")

    def mailboxes(self) -> list[dict]:
        res = self.call(
            [
                [
                    "Mailbox/get",
                    {
                        "accountId": self.account_id,
                        "ids": None,
                        "properties": ["name", "parentId", "role"],
                    },
                    "m",
                ]
            ],
            "Mailbox/get",
        )
        return res["m"].get("list") or []

    def identities(self) -> list[dict]:
        res = self.call(
            [["Identity/get", {"accountId": self.account_id, "ids": None}, "i"]], "Identity/get"
        )
        return res["i"].get("list") or []

    # ---- writes --------------------------------------------------------

    def ensure_child_mailbox(self, parent_id: str, name: str) -> str:
        for box in self.mailboxes():
            if box.get("parentId") == parent_id and box.get("name") == name:
                return box["id"]
        res = self.call(
            [
                [
                    "Mailbox/set",
                    {
                        "accountId": self.account_id,
                        "create": {"c": {"name": name, "parentId": parent_id}},
                    },
                    "s",
                ]
            ],
            "Mailbox/set",
        )
        created = (res["s"].get("created") or {}).get("c")
        if not created:
            raise JmapError("Mailbox/set", "not created")
        return created["id"]

    def move_email(self, email_id: str, mailbox_id: str) -> None:
        res = self.call(
            [
                [
                    "Email/set",
                    {
                        "accountId": self.account_id,
                        "update": {
                            email_id: {"mailboxIds": {mailbox_id: True}, "keywords/$seen": True}
                        },
                    },
                    "u",
                ]
            ],
            "Email/set move",
        )
        if email_id in (res["u"].get("notUpdated") or {}):
            raise JmapError("Email/set move", "not updated")

    def send_reply(
        self,
        *,
        to: str,
        from_addresses: list[str],
        subject: str,
        text: str,
        in_reply_to: list[str],
    ) -> None:
        """Send plain text to `to` only, from the first identity matching `from_addresses`."""
        identities = self.identities()
        if not identities:
            raise JmapError("Identity/get", "no identity")
        identity = identities[0]
        for wanted in from_addresses:
            match = [i for i in identities if (i.get("email") or "").lower() == wanted.lower()]
            if match:
                identity = match[0]
                break
        roles = {b.get("role"): b["id"] for b in self.mailboxes() if b.get("role")}
        if "drafts" not in roles or "sent" not in roles:
            raise JmapError("Mailbox/get", "drafts or sent mailbox missing")
        drafts, sent = roles["drafts"], roles["sent"]
        email = {
            "mailboxIds": {drafts: True},
            "keywords": {"$draft": True, "$seen": True},
            "from": [{"name": identity.get("name") or None, "email": identity["email"]}],
            "to": [{"name": None, "email": to}],
            "subject": subject,
            "bodyValues": {"b": {"value": text}},
            "textBody": [{"partId": "b", "type": "text/plain"}],
        }
        if in_reply_to:
            email["inReplyTo"] = in_reply_to
            email["references"] = in_reply_to
        res = self.call(
            [
                ["Email/set", {"accountId": self.account_id, "create": {"reply": email}}, "e"],
                [
                    "EmailSubmission/set",
                    {
                        "accountId": self.account_id,
                        "create": {"sub": {"emailId": "#reply", "identityId": identity["id"]}},
                        "onSuccessUpdateEmail": {
                            "#sub": {
                                f"mailboxIds/{drafts}": None,
                                f"mailboxIds/{sent}": True,
                                "keywords/$draft": None,
                            }
                        },
                    },
                    "s",
                ],
            ],
            "send reply",
        )
        if not (res["e"].get("created") or {}).get("reply"):
            raise JmapError("Email/set reply", "not created")
        if not (res.get("s", {}).get("created") or {}).get("sub"):
            raise JmapError("EmailSubmission/set", "not created")
