#!/usr/bin/env bash
#
# Copy each OPTED-IN archived PDF out of the private media archive into the
# built site, so the deploy publishes it.
#
# The archive is a private S3 bucket: a site's `_media/*.md` entries name an
# object in it (`pdf_archive_file`) but the bytes never live in the site repo,
# which is public. `pdf_public` is the editor's permission gate — off by
# default. This script is the ONLY thing that moves an object from the private
# archive onto the public web, and it moves exactly the ones whose gate is
# open. An entry with a key and `pdf_public: false` is not copied, so the file
# is not merely unlinked on the site, it is not there at all.
#
#   bash scripts/publish-opted-in-pdfs.sh [SITE_DIR]
#
# SITE_DIR defaults to `_site`. Configured by environment:
#   MEDIA_ARCHIVE_BUCKET   private bucket holding the PDFs (REQUIRED to do work)
#   MEDIA_ARCHIVE_PREFIX   key prefix inside it            (default: media-pdfs)
#   MEDIA_COLLECTION_DIR   where the entries live          (default: _media)
#   MEDIA_PUBLIC_DIR       path under SITE_DIR to write to (default: media-pdfs)
#
# Fail-soft vs fail-loud, deliberately split (see docs/MEDIA-ARCHIVE.md):
#   - No bucket configured  -> notice naming the exact knob, exit 0. A site that
#     has not adopted the archive must deploy normally.
#   - Bucket configured but an opted-in object is missing or unreadable -> exit
#     1. The page renders a "Download PDF" button for that entry, so shipping
#     without the file is a confident 404 in front of a visitor.
set -euo pipefail

SITE_DIR="${1:-_site}"
BUCKET="${MEDIA_ARCHIVE_BUCKET:-}"
PREFIX="${MEDIA_ARCHIVE_PREFIX:-media-pdfs}"
COLLECTION_DIR="${MEDIA_COLLECTION_DIR:-_media}"
PUBLIC_DIR="${MEDIA_PUBLIC_DIR:-media-pdfs}"

if [ -z "$BUCKET" ]; then
  echo "::notice::media archive not configured — no PDF published. To enable it," \
       "pass \`media_archive_bucket\` to the deploy workflow (or set" \
       "MEDIA_ARCHIVE_BUCKET). See cms-platform docs/MEDIA-ARCHIVE.md."
  exit 0
fi

if [ ! -d "$COLLECTION_DIR" ]; then
  echo "::notice::no ${COLLECTION_DIR}/ in this site — nothing to publish."
  exit 0
fi

# Parse the front matter with a REAL YAML parser, never a line scan (AGENTS.md).
# A regex cannot tell `pdf_public: true` apart from the same text inside a
# quoted string or a comment (a fixture whose TITLE contains that phrase proved
# it), and it reads an aliased or merge-keyed value wrong.
#
# Two things about how this is invoked are load-bearing:
#
#   * The ruby body is ASCII-ONLY. `ruby -e` parses its argument as US-ASCII, so
#     a single en dash in a message is `invalid multibyte char` -- a compile
#     error, not a warning.
#   * The status is CHECKED. `mapfile -t KEYS < <(ruby ...)` reads the exit code
#     of `mapfile`, never ruby's, so a ruby that died on line 1 produced an empty
#     key list and this script cheerfully reported "nothing to publish" and
#     exited 0. That is the masked-exit-code trap in AGENTS.md, and here it fails
#     OPEN: a broken parser silently unpublishes every opted-in PDF. Route
#     through a file so the failure is a failure.
KEYS_FILE="$(mktemp)"
trap 'rm -f "$KEYS_FILE"' EXIT

if ! ruby -ryaml -rdate -e '
  dir = ARGV[0]
  Dir.glob(File.join(dir, "*.md")).sort.each do |f|
    src = File.read(f, encoding: "utf-8")
    parts = src.split(/^---\s*$/, 3)
    next if parts.length < 3
    # Narrow rescue: malformed front matter is skippable, but anything else (a
    # missing constant, an IO error) must surface. A blanket `rescue
    # StandardError` here turned every entry into a skip when `Date` was an
    # undefined constant, and the run still reported success.
    fm = begin
      YAML.safe_load(parts[1], aliases: true, permitted_classes: [Date, Time])
    rescue Psych::SyntaxError, Psych::DisallowedClass => e
      warn "::warning::#{f}: front matter did not parse (#{e.class}), skipped"
      nil
    end
    next unless fm.is_a?(Hash)
    # Only a real boolean true opens the gate, mirroring the layout guard, so a
    # stray "false" / "no" / "" STRING can never publish anything.
    next unless fm["pdf_public"] == true
    key = fm["pdf_archive_file"].to_s.strip
    if key.empty?
      warn "::error::#{f}: pdf_public is true but pdf_archive_file is empty"
      exit 1
    end
    puts key
  end
' "$COLLECTION_DIR" > "$KEYS_FILE"; then
  echo "::error::could not read ${COLLECTION_DIR}/ front matter. Refusing to" \
       "deploy: an unreadable collection is indistinguishable from one with" \
       "nothing opted in, and guessing the second silently unpublishes every" \
       "PDF an editor has cleared." >&2
  exit 1
fi

mapfile -t KEYS < "$KEYS_FILE"

if [ "${#KEYS[@]}" -eq 0 ]; then
  echo "::notice::no media entry has \`pdf_public: true\` — nothing published" \
       "from the archive (this is the default, not a problem)."
  exit 0
fi

mkdir -p "${SITE_DIR}/${PUBLIC_DIR}"

published=0
for key in "${KEYS[@]}"; do
  # The key reaches both a filesystem path and an S3 key, so validate it rather
  # than trusting repo content: no directory separators, no traversal, .pdf only.
  if ! [[ "$key" =~ ^[A-Za-z0-9._-]+\.pdf$ ]] || [[ "$key" == *..* ]]; then
    echo "::error::refusing archive key ${key} — expected a bare <name>.pdf" >&2
    exit 1
  fi
  if ! aws s3 cp "s3://${BUCKET}/${PREFIX}/${key}" "${SITE_DIR}/${PUBLIC_DIR}/${key}"; then
    echo "::error::${key} is marked pdf_public but is not readable at" \
         "s3://${BUCKET}/${PREFIX}/${key}. Upload it (scripts/media-archive.sh" \
         "put) or untick the publish box; shipping without it renders a" \
         "download button that 404s." >&2
    exit 1
  fi
  published=$((published + 1))
done

echo "::notice::published ${published} opted-in PDF(s) from the private archive."
