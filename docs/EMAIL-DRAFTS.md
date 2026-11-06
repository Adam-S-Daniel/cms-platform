# Email to draft

What this is: the site owner emails a post to a secret posting address, and a
few minutes later it is a **draft** in `/admin`, exactly as if it had been
written there and saved. Nothing goes live until the owner opens the draft and
selects Publish. Read this before changing `.github/workflows/email-draft.yml`,
its thin caller `examples/site/.github/workflows/email-draft.yml`,
`scripts/email_draft/`, or `infrastructure/email-draft-poller/`, or when setting
the feature up for a site.

## How it works

1. The owner sends an email from their own address to `<posting-address>`. The
   subject becomes the title, the body the post (HTML is converted to
   Markdown, a trailing `-- ` signature is dropped), and up to 10 attached or
   inline images (JPEG, PNG, GIF, WebP, 10 MB each) are uploaded and placed.
2. A Fastmail rule files mail sent to `<posting-address>` into its own mailbox
   (for example `Create draft/example.com`).
3. The poller Lambda (`infrastructure/email-draft-poller/`, EventBridge once a
   minute; Fastmail has no webhooks) lists that mailbox over JMAP. For each
   message without the `$cms-dispatched` keyword it fires a
   `repository_dispatch` of type `email-draft`, `client_payload.email_id` set
   to the JMAP id, at the site repo its route names, then sets the keyword. It
   never reads a message's content or addresses.
4. The site's thin caller (`.github/workflows/email-draft.yml`) calls the
   platform reusable `email-draft.yml`, which validates the id, mints the CMS
   automation App's token, installs the pinned dependencies and runs
   `scripts/email_draft/email_draft.py process`.
5. `process` reads `cms.email_drafts.enabled`, `url` and `timezone` from the
   site's `_config.yml`, downloads the raw message over JMAP, runs every
   verification check below, skips an email already drafted, builds the post
   (Decap's own file name for the `posts` collection, front matter, body,
   images) and opens an editorial-workflow draft the way Decap does: a
   `cms/posts/<entry>` branch, Decap's pull request body marker and the
   `decap-cms/draft` label.
6. It replies to the owner with the `/admin` link to the draft and files the
   email under the `Processed` child of the mailbox it arrived in. On any
   failure it replies with what went wrong and what to do next, and files the
   email under `Failed`.

## Threat model

The posting address is a secret, but secrets leak (a forwarded thread, a
breach, a shoulder), so it is **not** the credential. The credential is the
owner's domain's DKIM signature. An attacker who knows the address must still
forge a signature by the owner's domain to get a draft opened, and even then
gets only a draft that the owner must publish.

Every check must pass (`scripts/email_draft/verify.py`):

| Check | Passes when |
|---|---|
| `dkim-signature` | dkimpy verifies a signature whose `d=` is the sender's domain or a parent of it, that signs From, To, Subject and Date, and that has no `l=` body-length limit (which would let a relay append text) |
| `single-headers` | From, To, Cc, Subject, Date and Message-ID each appear at most once, so the instance read is the one the signature covers |
| `from-address` | From holds exactly one address, and it is `EMAIL_DRAFT_SENDER` |
| `posting-address` | `<posting-address>` is in To or Cc, and that header is signed, so an old signed email re-sent to the posting address fails |
| `fastmail-results` | the topmost run of Authentication-Results, added by Fastmail's own servers, says DKIM (aligned), DMARC and SPF passed; lower ones are ignored because a sender can write them |
| `date-fresh` | Date is within the last 24 hours and at most 10 minutes ahead |
| `message-id` | a Message-ID is present (it keys the duplicate check) |

Around the checks:

- **Replies go only to `EMAIL_DRAFT_SENDER`**, never to From or Reply-To, so a
  spoofed message warns the owner instead of sending backscatter to a forged
  address.
- **Duplicates are skipped.** A sha256 of the Message-ID is stamped into the
  draft's pull request body; an email whose hash is already on a pull request
  gets an "already drafted" reply. The poller can dispatch an email twice (a
  dispatch that succeeded but whose keyword write failed), and the reusable's
  per-email-id concurrency group queues the second run behind the first, so it
  finds the draft instead of racing it.
- **Drafts only.** The script never merges and never adds a publish label.
- **Least privilege.** The reusable's own token is `contents: read`. The draft
  is written with the CMS automation App's token, minted per run, scoped to the
  one repository and `contents=write,pull_requests=write`. It must be the App
  and not `github.token`: GitHub starts no workflows for a pull request a
  GITHUB_TOKEN opened, so the site's required checks would never run and
  Publish could never merge the draft. The poller holds its own App credential
  (Contents read and write, which `repository_dispatch` needs) in Secrets
  Manager.
- **Public logs.** Site repos are public, and so are their run logs. The first
  step masks both addresses and the Fastmail token; inputs reach shell steps
  only through `env:`; the email id is validated against
  `^[A-Za-z0-9_-]{1,255}$` before use; the run-name names only the event. The
  script and the poller log only step names, check names, counts, HTTP statuses
  and error class names, never an address, subject, body, header, token or API
  response body.

## Setting it up for a site

1. **Fastmail mailboxes.** Create a mailbox for the site (for example
   `Create draft/example.com`) with two children, `Processed` and `Failed`. Add
   a rule that files mail sent to `<posting-address>` into it. Use a long,
   random local part for `<posting-address>`.
2. **Fastmail API token.** Settings, Privacy & Security, Manage API tokens:
   a token with the **Email** (read and write) and **Email submission** scopes.
   The site workflow needs both (it reads, replies and moves); the poller needs
   only Email.
3. **The poller.** Deploy it once per AWS account with
   `bash infrastructure/email-draft-poller/deploy.sh` (AWS CLI v2, SAM CLI,
   python3). Set `ROUTES` to a JSON array mapping each mailbox path to a repo,
   for example
   `[{"mailbox": "Create draft/example.com", "repo": "<owner>/<repo>"}]`,
   plus `FASTMAIL_API_TOKEN`, `GITHUB_APP_CLIENT_ID` and
   `GITHUB_APP_PRIVATE_KEY_FILE` on the first deploy, and optionally
   `ALERT_EMAIL` for the alarms. Secrets go to Secrets Manager; the stack gets
   only their ARNs. Adding a site is a redeploy with one more route.
4. **GitHub secrets** on the site repo: `FASTMAIL_API_TOKEN`,
   `EMAIL_DRAFT_ADDRESS` (`<posting-address>`), `EMAIL_DRAFT_SENDER` (the
   owner's own address, for example `owner@example.com`), and
   `CMS_AUTOMATION_APP_PRIVATE_KEY` with the `CMS_AUTOMATION_APP_ID` variable
   (already present on a site that runs `platform-bump`).
5. **The thin caller.** `platform-bump` seeds
   `.github/workflows/email-draft.yml` into each consumer; a scaffolded site
   gets it from `examples/site/`.
6. **The flag.** In `_config.yml`:

   ```yaml
   cms:
     email_drafts:
       enabled: true
   ```

   The site also needs a `url:` (the reply's `/admin` link) and may set
   `timezone:` (the post's date; UTC otherwise). With the flag off, a dispatched
   email gets a "turned off" reply and is filed under `Failed`; nothing is
   drafted.

## Testing

- Unit tests: `python3 -m pip install --use-pep517 -r scripts/email_draft/requirements.txt`,
  then `python3 -m pytest scripts/email_draft -q` (self-ci's
  `python-unit-tests` lane runs it). The Decap slug port is checked against
  golden output from Decap's own code (`tests/generate_slug_golden.cjs`).
- The poller: `e2e/email-draft-poller.test.js` (node-unit-lints).
- A live check: send an email, find its JMAP id, and dispatch the site's
  `Email to draft` workflow by hand with that `email_id` and `dry_run: true`
  (the default). A dry run verifies and logs the plan but creates nothing,
  sends nothing and moves nothing.

## Failure modes and where each is reported

| What failed | Owner reply | Email filed under | Also visible |
|---|---|---|---|
| Flag off | "turned off" | `Failed` | green run |
| A verification check | which checks failed, and to resend from their own address | `Failed` | red run; log names the checks |
| The email cannot become a post (no subject, no text, more than 10 images, an image over 10 MB) | the reason | `Failed` | red run |
| Already drafted | "already drafted", with the link | `Processed` | green run |
| GitHub API (branch, blobs, pull request) | retry in a few minutes | `Failed` | red run; log has the HTTP status |
| Fastmail API while fetching | none (the message could not be read) | stays in the mailbox | red run |
| Missing secret or unreadable `_config.yml` | none | stays in the mailbox | red run; log names the missing env names or the error class |
| A step before `process` (checkout, install, App token mint) | generic failure, from `notify-failure` | `Failed` | red run |
| The poller (Fastmail, GitHub dispatch) | none | stays in the mailbox and is retried next minute | CloudWatch alarm (errors, or no invocations for 15 minutes), to `ALERT_EMAIL` when set |

A red run of `Email to draft` is a red `repository_dispatch` run on the default
branch, so the fleet's scheduled-run-health audit lists it in its tracking
issue. A failed verification is red on purpose: someone sent mail to the
posting address that did not verify, which is worth a look even though the owner
was also told.
