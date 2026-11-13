# Media discovery

A weekly job that finds new talks, podcasts, press mentions, articles and
briefs about a site's person and proposes each one as an ordinary `/admin`
entry waiting for review. Nothing reaches the live site until a human presses
Publish.

- Reusable workflow: `.github/workflows/media-discovery.yml`
- Thin caller (platform-dictated, so every consumer carries it):
  `examples/site/.github/workflows/media-discovery.yml`
- Code: `scripts/media_discovery/` (tests in `scripts/media_discovery/tests/`,
  run by self-ci's `python-unit-tests` lane)
- Per-site switch: `.github/media-discovery.yml` in the site repo. Without it
  the run is a green no-op that takes seconds.

## What one run does

1. **Ask.** One streaming request to Claude Opus 5.5 (`claude-opus-5-5`) with
   three tools: web search (up to 25 searches), web fetch (up to 25 fetches)
   and `submit_candidates`, a client tool whose strict input schema is the
   candidate list. The model has no tool that writes anything. The request
   uses adaptive thinking at `effort: high`, resumes a `pause_turn` up to 5
   times, and opts into the server-side refusal fallback
   (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`). A refusal,
   a response cut off at `max_tokens`, or a run that ends without calling
   `submit_candidates` yields zero candidates and a `::warning::`, not a
   failure.
2. **Validate** every candidate in code (`candidate.parse_candidates`); the
   strict schema is a convenience, not the check.
3. **Skip duplicates** (`dedupe.is_duplicate`).
4. **Re-fetch** every URL the model cited (`fetch.fetch`) and **corroborate**
   (`corroborate.verify`).
5. **Propose.** Each confirmed find becomes one pull request shaped exactly
   like a Decap editorial-workflow entry (live mode), or a line in the email
   (email-only mode).
6. **Email** one digest listing the new PRs (or, in email-only mode, what
   would have been opened) and every find that did not check out, with the
   reasons.

## The verification rules (phase 1, precisely)

**Candidate validation** (`candidate.py`). `kind` is one of `upcoming_talk`,
`past_talk`, `podcast`, `press`, `authored_article`, `brief_testimony`.
`title` is non-empty and at most 300 characters; `outlet` is a string; `date`
is a real `YYYY-MM-DD` or `YYYY-MM`; `end_date`, when given, is a full
`YYYY-MM-DD`; every URL is http(s) with a host. Supporting URLs are capped at
8, evidence quotes at 600 characters, the reasoning at 1,500. An invalid
candidate is dropped and counted, never repaired.

**Duplicates** (`dedupe.py`). URLs are compared after normalization: scheme
lowercased, a leading `www.` and default port dropped, `utm_*`, `fbclid` and
`gclid` removed, the query sorted, the fragment and a trailing slash dropped.
A candidate is skipped when any of its URLs:

- is named in an earlier pull request labeled `media-discovery`, open or
  closed (each PR body starts with a `<!-- media-discovery:v1 url=... -->`
  marker), so a rejected find is never proposed again;
- is already on the site (`article_url` in the media folder, `event_url` in
  the events folder);

or when its title matches an existing item's title, compared on letters and
digits only, case-insensitively.

**Talk timing** (`corroborate.effective_kind`). The model's upcoming/past label
is ignored for talks: a talk is `upcoming_talk` when its end date (or its only
date, a bare month counting as the month's last day) is today or later, and
`past_talk` otherwise.

**A source qualifies** (`corroborate.verify`) when all of these hold:

- it answered HTTP 2xx with an HTML or plain-text body;
- neither the cited URL nor the final URL after redirects is on a blocked
  domain (compared by registrable domain);
- **identity** (`identity.py`): one of the configured names appears as a whole
  phrase (case-insensitive, any whitespace between words) with an identity
  marker within `near_chars` characters of it, and no exclusion marker within
  `near_chars` of that same occurrence. A marker written in all capitals (an
  acronym) must match case exactly;
- **support**: the normalized page text (NFKC, ASCII quotes and dashes,
  casefolded, whitespace collapsed) contains the candidate's normalized title,
  and the candidate's year appears as a standalone number. For the two talk
  kinds a supporting page may name the outlet instead of the title; the
  primary page must always carry the title.

**Independence.** Sources are grouped into clusters: two pages are in the same
cluster when they share a registrable domain (the last two labels, or three
under a short list of multi-part suffixes such as `co.uk`), or when their
8-word shingles overlap with a Jaccard similarity of 0.6 or more (a syndicated
copy of the same press release). A candidate is **confirmed** only when the
primary source qualifies and at least one other qualifying source sits in a
different cluster from it.

**Rendering** (`render.py`). Kinds map to a collection and media category:
upcoming talks go to the events folder (slug `<YYYY-MM-DD>-<title-slug>`; an
event without a full date cannot be rendered and is reported as unconfirmed),
everything else to the media folder (slug `<weight>-<title-slug>`, categories
Talks & Panels, Podcasts & Interviews, Press Coverage, Articles & Commentary,
Briefs, Testimony & Reports). Every value is one line, with control and
Unicode format characters (bidi overrides, zero-width characters) removed and
capped at 300 characters. The front matter is written with PyYAML, which does
the quoting, and holds the source's raw text: it is not HTML-escaped. Those
fields come from web pages, so a consuming site must escape them where it
prints them (Liquid `| escape` in HTML text and attributes). The branch is `cms/<collection>/<slug>`,
which is what makes Decap treat the PR as one of its own entries.

## Site configuration: `.github/media-discovery.yml`

```yaml
person:
  # Every form of the name that appears in bylines, filings and programs.
  names: ["Pat Rivera", "Pat Q. Rivera", "Patricia Quinn Rivera"]
  # At least one must appear near the name on every qualifying page.
  identity_markers: ["Northwind Legal", "Office of Data Policy", "ODP"]
  # Someone else with the same name; a page that ties the name to one of
  # these is not about the subject.
  exclusion_markers: ["Bluebird Advisors"]
  # How close, in characters, a marker must be to the name (1-5000, default 600).
  near_chars: 600
sources:
  # Left out of search results and never counted as a source (registrable domains).
  blocked_domains: ["content-farm.example.net"]
  # https pages the model checks first (a bio page, a speaking page).
  seed_urls: ["https://www.example.com/people/pat-rivera"]
# Extra search phrasing for the model.
search_hints: ["Pat Rivera data policy panel", "Rivera Northwind Legal webinar"]
# Optional; these are the defaults.
collections:
  media: {folder: _media, weight: 1}
  events: {folder: _events}
```

Unknown keys are an error, so a typo fails the run (`::error::` naming the
problem) instead of being ignored.

## Secrets and variables (set on the site repo)

| Knob | Kind | Needed for | Without it |
| --- | --- | --- | --- |
| `MEDIA_DISCOVERY_ANTHROPIC_API_KEY` | secret (passed as `anthropic_api_key`) | any run | `::notice::` naming it; green no-op |
| `MEDIA_DISCOVERY_SMTP_USER` | secret (`smtp_user`) | the email; the From address unless `MEDIA_DISCOVERY_MAIL_FROM` is set | `::notice::` naming it; no email |
| `MEDIA_DISCOVERY_SMTP_PASSWORD` | secret (`smtp_password`) | the email | `::notice::` naming it; no email |
| `MEDIA_DISCOVERY_MAIL_TO` | secret (`mail_to`) | the email; comma-separated recipients | `::notice::` naming it; no email |
| `MEDIA_DISCOVERY_MAIL_FROM` | secret (`mail_from`) | optional: the From address, when it differs from the SMTP login; the account must be allowed to send as it (for example a Fastmail alias). A value that is not a single email address is ignored with a `::warning::` naming this knob | the SMTP login is the From address |
| `MEDIA_DISCOVERY_MODE` | variable | `live` opens PRs | email-only |
| `MEDIA_DISCOVERY_REVIEWERS` | variable | comma-separated GitHub logins requested on each PR | no reviewers requested |
| `CMS_AUTOMATION_APP_ID` | variable | live mode (the PR-writing App) | email-only, with a `::notice::` |
| `CMS_AUTOMATION_APP_PRIVATE_KEY` | secret (`app_private_key`) | live mode | email-only, with a `::notice::` |

The SMTP host defaults to `smtp.fastmail.com` on port 587, upgraded with
STARTTLS before the login (the setup Fastmail gives its own mail clients); the
CLI reads `MEDIA_DISCOVERY_SMTP_HOST` if a different host is ever needed. The
reusable derives the `/admin` link from `_config.yml` (`cms.admin_origin`, else
`url`, plus `/admin/`) and the site name from `title` (else the repository
name), with a YAML parser.

The CLI can also be run by hand:

```bash
PYTHONPATH=<platform>/scripts python3 -m media_discovery run \
  --site-root <site checkout> --repo <owner>/<repo> --mode email-only \
  [--today YYYY-MM-DD] [--no-email]
```

## Modes

- **email-only** (the default): nothing is written to GitHub. The digest lists
  each confirmed find as "would open a pull request", with the file it would
  add. Use it to judge the quality of the finds before turning PRs on. It
  lists earlier discovery PRs with the job's read-only `GITHUB_TOKEN`; if that
  token cannot, the run continues without that duplicate check (a notice, not
  a failure).
- **live**: each confirmed find becomes a PR from the CMS automation App,
  minted with only `contents=write,pull_requests=write` and narrowed to the
  site's repository. It never falls back to `GITHUB_TOKEN`: a PR that token
  opens starts no workflows, so its required checks would never report and
  Publish could never merge it.

## Reviewing a find in /admin

Each PR shows in `/admin` under **Workflow → In review**, like an entry an
editor saved. The PR on GitHub carries the evidence: every source URL, the
domain, which identity marker matched and the sentence around the name, plus
the model's reasoning.

- **Approve:** open the entry, correct anything (the title and outlet are
  copied verbatim from the source, which is not always how the site words
  them), then **Publish**. The site's normal required checks run; the merge
  deploys it.
- **Reject:** open the entry and delete it (**Delete unpublished entry**).
  Decap closes the PR. The closed PR keeps its marker and label, so the same
  find is never proposed again.

## Cost

Claude Opus 5.5 is $4 per million input tokens and $20 per million output
tokens; web search is $10 per 1,000 searches (web fetch has no per-use fee
beyond the tokens it adds). A typical run of about 40 searches and about 300k
tokens read comes to roughly $2-4, so a weekly schedule is roughly $10-15 a
month per site. The per-request caps (25 searches, 25 fetches, 64k output
tokens, 5 continuations) bound the worst case.

## Security model

- **The model cannot write.** Its only client tool returns data; code does
  every write, after validation, re-fetching and corroboration, and a human
  publishes.
- **Web content is data.** The system prompt says so, and nothing the model
  says is trusted: every claim is re-checked against pages the code fetched
  itself.
- **SSRF guard** (`fetch.py`): http(s) only; every hop's host must resolve only
  to public (`is_global`) addresses, which keeps the runner's link-local
  metadata endpoint and private ranges out of reach; redirects are followed
  by hand (at most 5), re-checked on every hop; 20-second timeout; at most
  3 MB read; only HTML, XHTML and plain text are parsed. Known limit: the
  check resolves the host and urllib resolves it again to connect, so DNS
  rebinding is not caught; fetched text is never logged, which bounds the
  impact.
- **Counts-only logs.** The repository and its Actions logs are public. The
  CLI prints counts and fixed messages only: never a title, name, URL, quote or
  address. API, GitHub and SMTP errors are reported by class and HTTP status,
  never by message or response body. The one exception is a refused SMTP
  login, which no class name explains: the log then shows the host and port,
  the TLS version, the server's EHLO extensions and advertised AUTH
  mechanisms, each mechanism tried with the server's reply code and text,
  and the shape of the user name and password (length, whitespace, line
  breaks, non-ASCII). The reply text has every address, the user name, its
  local part and the password replaced, and is one line of at most 300
  characters. smtplib's debug output is never turned on: it prints the AUTH
  exchange, which carries the credentials. The workflow passes every input,
  variable and secret through `env:`, and masks the SMTP user and each
  recipient before the CLI runs.
- **Safe PR bodies** (`render.safe_md`): web text in a PR body is escaped so
  it cannot render HTML or links, @-mention anyone, reference an issue, or
  close one with a closing keyword. Every ASCII punctuation character is
  backslash-escaped per CommonMark 0.31.2 section 2.4, and GitHub word
  joiners break each mention, reference and autolink trigger.
