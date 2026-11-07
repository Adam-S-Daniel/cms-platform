from datetime import date
from types import SimpleNamespace

from md_fixtures import CFG

from media_discovery import llm
from media_discovery.candidate import CANDIDATES_JSON_SCHEMA
from media_discovery.config import load_config
from media_discovery.dedupe import ExistingItem

TODAY = date(2026, 11, 2)

GOOD = {
    "kind": "press", "title": "Agencies and Open Data", "outlet": "Example Times",
    "date": "2026-05-04", "end_date": None, "location": None, "session": None,
    "primary_url": "https://news.example.com/open-data",
    "supporting_urls": ["https://other.example.org/recap"],
    "evidence": [{"url": "https://news.example.com/open-data", "quote": "Pat Rivera said"}],
    "reasoning": "Northwind Legal named.",
}


def block(type_, **kw):
    return SimpleNamespace(type=type_, **kw)


def message(stop_reason, *content):
    return SimpleNamespace(stop_reason=stop_reason, content=list(content))


def submit(payload):
    return block("tool_use", id="toolu_1", name="submit_candidates", input=payload)


class FakeStream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self.msg


class FakeClient:
    """Stands in for anthropic.Anthropic: client.beta.messages.stream(**kw)."""

    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kw):
        # Snapshot the message list: the caller appends to it after this returns.
        self.calls.append({**kw, "messages": list(kw["messages"])})
        return FakeStream(self.responses.pop(0))


def run(client, existing=(), cfg=CFG):
    return llm.find_candidates(cfg, list(existing), TODAY, client)


def test_submit_is_parsed_into_candidates_and_drops():
    client = FakeClient(message("tool_use", block("text", text="Done."),
                                submit({"candidates": [GOOD, {"kind": "nope"}]})))
    cands, notes = run(client)
    assert [c.title for c in cands] == ["Agencies and Open Data"]
    assert len(notes) == 1 and notes[0].startswith("candidate 1:")
    assert len(client.calls) == 1


def test_request_shape():
    client = FakeClient(message("tool_use", submit({"candidates": []})))
    assert run(client) == ([], [])
    kw = client.calls[0]
    assert kw["model"] == "claude-opus-5-5" and kw["max_tokens"] == 64000
    assert kw["tool_choice"] == {"type": "auto"}
    assert kw["thinking"] == {"type": "adaptive"}
    assert kw["output_config"] == {"effort": "high"}
    assert kw["fallbacks"] == "default" and kw["betas"] == ["server-side-fallback-2026-07-01"]
    search, web_fetch, sub = kw["tools"]
    assert search == {"type": "web_search_20260209", "name": "web_search", "max_uses": 25,
                      "blocked_domains": ["example.net"]}
    assert web_fetch == {"type": "web_fetch_20260209", "name": "web_fetch", "max_uses": 25}
    assert sub["name"] == "submit_candidates" and sub["strict"] is True


def test_blocked_domains_omitted_when_none_configured():
    cfg = load_config("person: {names: [Pat Rivera], identity_markers: [Northwind Legal]}")
    client = FakeClient(message("tool_use", submit({"candidates": []})))
    run(client, cfg=cfg)
    assert "blocked_domains" not in client.calls[0]["tools"][0]


def test_strict_schema_drops_unsupported_keywords_and_keeps_structure():
    strict = llm.strict_schema(CANDIDATES_JSON_SCHEMA)
    text = repr(strict)
    for word in ("maxLength", "maxItems", "minLength", "minItems"):
        assert word not in text
    assert "maxLength" in repr(CANDIDATES_JSON_SCHEMA)  # the original is untouched
    item = strict["properties"]["candidates"]["items"]
    assert item["additionalProperties"] is False
    assert set(item["required"]) == set(item["properties"])
    assert item["properties"]["end_date"] == {"anyOf": [{"type": "string"}, {"type": "null"}]}
    assert item["properties"]["kind"]["enum"][0] == "upcoming_talk"


def test_today_and_existing_items_go_in_the_user_message_not_the_system_prompt():
    existing = [ExistingItem("https://site.example.com/a", "Old Talk"),
                ExistingItem(None, "Untitled Brief")]
    client = FakeClient(message("tool_use", submit({"candidates": []})))
    run(client, existing)
    kw = client.calls[0]
    user = kw["messages"][0]
    assert user["role"] == "user"
    assert "2026-11-02" in user["content"]
    assert "Old Talk" in user["content"] and "https://site.example.com/a" in user["content"]
    assert "Untitled Brief" in user["content"]
    system = kw["system"][0]["text"]
    assert "2026" not in system and "Old Talk" not in system
    assert "Pat Q. Rivera" in system and "Northwind Legal" in system
    assert "Bluebird Advisors" in system and "different person" in system


def test_system_prompt_is_byte_stable_across_runs():
    a, b = FakeClient(message("tool_use", submit({"candidates": []}))), \
        FakeClient(message("tool_use", submit({"candidates": []})))
    llm.find_candidates(CFG, [], date(2026, 1, 1), a)
    llm.find_candidates(CFG, [ExistingItem(None, "x")], date(2027, 6, 30), b)
    assert a.calls[0]["system"] == b.calls[0]["system"]
    assert a.calls[0]["tools"] == b.calls[0]["tools"]


def test_existing_items_are_capped_at_200():
    existing = [ExistingItem(f"https://site.example.com/{i}", f"Item {i:04d}") for i in range(250)]
    client = FakeClient(message("tool_use", submit({"candidates": []})))
    run(client, existing)
    content = client.calls[0]["messages"][0]["content"]
    assert "Item 0199" in content and "Item 0200" not in content
    assert "first 200 of 250" in content


def test_seed_urls_and_hints_are_passed():
    cfg = load_config("person: {names: [Pat Rivera], identity_markers: [Northwind Legal]}\n"
                      "sources: {seed_urls: ['https://firm.example.com/people/pat']}\n"
                      "search_hints: ['Pat Rivera data policy panel']")
    client = FakeClient(message("tool_use", submit({"candidates": []})))
    run(client, cfg=cfg)
    content = client.calls[0]["messages"][0]["content"]
    assert "https://firm.example.com/people/pat" in content
    assert "Pat Rivera data policy panel" in content


def test_pause_turn_is_continued_with_the_assistant_content():
    paused = message("pause_turn", block("server_tool_use", id="srvtoolu_1", name="web_search",
                                         input={"query": "x"}))
    client = FakeClient(paused, message("tool_use", submit({"candidates": [GOOD]})))
    cands, notes = run(client)
    assert len(cands) == 1 and notes == []
    assert len(client.calls) == 2
    second = client.calls[1]["messages"]
    assert [m["role"] for m in second] == ["user", "assistant"]
    assert second[1]["content"] == paused.content
    assert client.calls[0]["system"] == client.calls[1]["system"]


def test_pause_turn_gives_up_after_five_continuations():
    client = FakeClient(*[message("pause_turn") for _ in range(6)])
    assert run(client) == ([], [llm.STILL_PAUSED])
    assert len(client.calls) == 6


def test_refusal_returns_nothing_even_with_a_partial_submit():
    client = FakeClient(message("refusal", submit({"candidates": [GOOD]})))
    assert run(client) == ([], [llm.REFUSED])


def test_max_tokens_returns_nothing():
    client = FakeClient(message("max_tokens", submit({"candidates": [GOOD]})))
    assert run(client) == ([], [llm.TRUNCATED])


def test_missing_submit_returns_a_reason():
    client = FakeClient(message("end_turn", block("text", text="Here is what I found...")))
    assert run(client) == ([], [llm.NO_SUBMIT])


def test_outcome_notes_carry_no_model_text():
    for note in llm.OUTCOME_NOTES:
        assert "{" not in note and note.isascii()
