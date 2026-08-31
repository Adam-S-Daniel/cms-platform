# The private media archive

A site's `_media` entries link to work published elsewhere, and an archived PDF
copy of each is genuinely useful — links rot, and some pieces get hard to find.
But a PDF of someone else's article is someone else's copyright, so publishing
one has to be a decision a person makes item by item, never a side effect of
uploading a file.

Three rules encode that, and they are the whole design:

1. **The PDF bytes never enter the site repo.** A consumer site repo is
   PUBLIC. A committed PDF is world-readable at `raw.githubusercontent.com`
   whatever the site chooses to render, and git history is immutable — a later
   `git rm` fixes the working tree and nothing else. So the bytes live in a
   **private S3 bucket** and the repo carries only an object *name*.
2. **Default is withhold, and withhold means absent.** An entry with
   `pdf_public: false` (the default) gets no download button *and* is never
   copied out of the archive — so the file is not on the website to be found.
   Hiding a link to a file sitting at a guessable URL is not a permission gate.
3. **Opening the gate is an editor's explicit act** — one checkbox in `/admin`,
   labelled with what it means.

## Where everything lives

| Thing | Path | Repo |
|---|---|---|
| Bucket (CloudFormation) | `infrastructure/bootstrap/template.yaml` → `MediaArchiveBucket` | cms-platform |
| Deploy-time publish script | **`scripts/publish-opted-in-pdfs.sh`** | cms-platform |
| Production wiring | `.github/workflows/deploy-production.yml` → *Publish opted-in archived PDFs* | cms-platform |
| Preview wiring | `.github/workflows/deploy-preview.yml` → same step | cms-platform |
| Upload / list / presign helper | `scripts/media-archive.sh` | **the site repo** |
| Render a PDF from an article | `scripts/archive-article-pdf.py` | **the site repo** |
| Content model + editor fields | `docs/CONTENT-MODEL.md`, "Archived PDFs" | **the site repo** |

## Setting up the S3 bucket (one time, per site)

The bucket is created by the **bootstrap stack**, so there is nothing to click
in the console. It is optional: leave `MediaArchiveBucketName` empty and no
bucket is created and nothing else changes.

1. **Name it.** Convention is the resource prefix plus `-media-archive`, e.g.
   `jodidaniel-com-media-archive`.

2. **Add it to the site's bootstrap params** (`infrastructure/site-params.env`
   in the site repo — gitignored; copy from `site-params.example.env`):

   ```sh
   MEDIA_ARCHIVE_BUCKET=jodidaniel-com-media-archive
   ```

3. **Redeploy the bootstrap stack.** It is an ordinary stack update: one new
   bucket and one read-only IAM statement, touching no existing bucket,
   distribution or DNS record. HOW you run it differs per site, because not
   every consumer ships a wrapper:

   **adamdaniel.ai** has `infrastructure/bootstrap/deploy.sh` — a thin wrapper
   that checks the platform out at `platform.lock`'s `platform_ref` and
   exports the site's params itself:

   ```sh
   MEDIA_ARCHIVE_BUCKET=adamdaniel-ai-media-archive \
     bash infrastructure/bootstrap/deploy.sh
   ```

   **jodidaniel.com has no such wrapper** — only
   `infrastructure/site-params.example.env`. Source the params and run the
   PLATFORM's script from a cms-platform checkout:

   ```sh
   set -a; source infrastructure/site-params.env; set +a
   STACK_NAME=jodidaniel-com-bootstrap \
   MEDIA_ARCHIVE_BUCKET=jodidaniel-com-media-archive \
     bash /path/to/cms-platform/infrastructure/bootstrap/deploy.sh
   ```

   > **Set `STACK_NAME` explicitly there, and do not skip it.** That params
   > file exports `STACK_NAME="jodidaniel-com-oauth-proxy"` for the OAuth-proxy
   > deploy, and the bootstrap script honours an inherited `STACK_NAME`
   > (`${STACK_NAME:-${RESOURCE_PREFIX}-bootstrap}`). Sourcing the file and
   > running the bootstrap deploy without overriding it aims the BOOTSTRAP
   > template at the OAuth-proxy stack. Overriding it on the command line, as
   > above, is the whole fix.

   > **Until this change is released and the consumer bumped**, a wrapper that
   > checks the platform out at `platform_ref` will fetch a template that has
   > no `MediaArchiveBucketName` parameter and the deploy will reject it. Run
   > the platform script from a checkout of the branch/tag that carries it, or
   > wait for the release.

   > On adamdaniel.ai the wrapper must keep exporting
   > `CREATE_APEX_DNS_RECORDS=true`. It is a live apex and the A-records are
   > stack-managed; a redeploy without it DELETES them. That is unrelated to
   > this change and is already documented in that repo's AGENTS.md — it is
   > called out here because this is a reason to redeploy the stack.

4. **Confirm it came out private.** The template blocks public access on all
   four axes and attaches no bucket policy, but verify rather than assume:

   ```sh
   aws s3api get-public-access-block --bucket jodidaniel-com-media-archive
   # expect all four values true
   aws s3api get-bucket-policy --bucket jodidaniel-com-media-archive
   # expect: NoSuchBucketPolicy
   ```

5. **Point the deploys at it.** In the site's thin callers
   (`.github/workflows/deploy-production.yml` and `deploy-preview.yml`), add:

   ```yaml
   with:
     media_archive_bucket: jodidaniel-com-media-archive
     platform_ref: v0.1.97   # production caller only; must equal the uses:@ ref
   ```

   `media_archive_bucket` (both callers) and `platform_ref` (production only)
   are exactly the two inputs `examples/site/.github/workflows/deploy-*.yml`
   ship commented out, and `scripts/check-platform-pin-consistency.js` knows
   it: it treats both as deliberately OPTIONAL per-site inputs
   (`OPTIONAL_WITH_KEYS`), so adding them no longer trips
   `workflow-content: DRIFT` on the required `pin-consistency` check —
   uncommenting the pair really is a supported opt-in, not just a documented
   one. **On the production caller, uncomment both lines together.**
   `platform_ref` is what fetches the publish script, and the reusable's
   `platform_ref` input DEFAULTS TO `main` — so `media_archive_bucket` set
   without `platform_ref` would publish PDFs to the live site from an
   unpinned checkout, and `check-platform-pin-consistency.js` fails the build
   on exactly that pairing. `platform-bump` moves `platform_ref` in lockstep
   with the `uses:@` pin once it is present. The preview caller already
   passes `platform_ref` unconditionally (it already checks the platform
   out), so it needs only the bucket line.

Both inputs default to empty, so a site that skips all of this deploys exactly
as before.

## Putting a PDF in the archive

From the **site repo** (needs AWS credentials that can write the bucket):

```sh
bash scripts/media-archive.sh put /path/to/1-fda-amicus.pdf
bash scripts/media-archive.sh list
bash scripts/media-archive.sh audit    # every pdf_archive_file resolves to an object
bash scripts/media-archive.sh link 1-fda-amicus.pdf 900   # presigned URL, 15 min
```

Objects live under the `media-pdfs/` prefix. Then set the entry's
**Archived PDF** field in `/admin` to that file name, and leave **Publish this
PDF on the public website** unticked unless we may lawfully republish it.

## What happens at deploy time

`scripts/publish-opted-in-pdfs.sh` runs after AWS credentials are configured
and before the S3 sync — the copied files have to be in the tree that
`aws s3 sync --delete` uploads, and reading the archive needs the role.

It parses each entry's front matter with a **real YAML parser**, never a line
scan. That is not pedantry: a fixture whose *title* contained the text
`pdf_public: true` proved a regex would publish it.

Its two failure modes are deliberately different:

| Situation | Behaviour |
|---|---|
| No `media_archive_bucket` configured | Notice naming the exact knob, **exit 0** |
| No entry has `pdf_public: true` | Notice — this is the default, not a problem, **exit 0** |
| An opted-in PDF is missing from the archive | `::error::`, **exit 1** |
| The front matter cannot be read at all | `::error::`, **exit 1** |
| An archive key is not a bare `<name>.pdf` | `::error::`, **exit 1** |

The last three are loud on purpose. An entry with the box ticked renders a
"Download PDF" button, so deploying without the file puts a confident 404 in
front of a visitor; and an unreadable collection is indistinguishable from one
with nothing opted in, so guessing the second would silently unpublish every
PDF an editor had cleared.

Two traps this script exists having already fallen into, both caught by
negative controls before it shipped:

- `mapfile -t KEYS < <(ruby …)` reads **`mapfile`'s** exit code, never ruby's.
  A ruby that died on line 1 produced an empty key list and the run reported
  "nothing to publish" and exited 0 — failing *open*. The parse now goes
  through a file so its status is checked.
- `ruby -e` parses its argument as **US-ASCII**, so a single en dash in a
  message inside the script body is `invalid multibyte char` — a compile error.
  The ruby body is ASCII-only for that reason.

## The IAM grant is read-only, and that is the point

The GitHub Actions role gets `s3:GetObject` + `s3:ListBucket` on the archive and
nothing else, in its own policy statement. The deploy copies a PDF *out*; it
must never be able to overwrite or delete the only copy of a rendered capture.
Versioning is on for the same reason.

## What this does not solve

The archive keeps the PDFs off the public website and out of the public repo.
It does not decide whether republishing a given article is lawful — that is
what the checkbox is for, and it is a person's call.
