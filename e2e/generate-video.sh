#!/usr/bin/env bash
set -euo pipefail

CHANGES_FILE="${1:-/tmp/page-changes.json}"
DIFFS_FILE="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REGRESSION_DIR="${SCRIPT_DIR}/../screenshots/regression"
PR_DIR="${REGRESSION_DIR}/pr"
PROD_DIR="${REGRESSION_DIR}/prod"
OUTPUT="${REGRESSION_DIR}/comparison.mp4"
TEMP_DIR="${REGRESSION_DIR}/temp"
mkdir -p "$TEMP_DIR"

PR_NUMBER="${PR_NUMBER:-0}"
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
FONT_REGULAR="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

# Output frame: 1920×1080. Each side image fills 940×540 with letterboxing,
# hstacked to 1880×540, padded out to 1920×1080 to leave room for an 80px
# top status bar and a slim bottom label.
WIDTH=1920
HEIGHT=1080
SIDE_W=940
SIDE_H=540
# hstack of the two SIDE_W panels is 1880px wide before padding out to WIDTH.
TOP_BAR_H=80 # space reserved at top for the per-page indicator

# Parse all pages into a flat list with the changeset classification
# (CHANGED / NEW / UNCHANGED — what the changeset *might* have touched)
# AND the visual classification from compute-visual-diffs.js
# (DIFFERENT / IDENTICAL / NEW — what the screenshots actually show).
node -e "
  const fs = require('fs');
  const c = JSON.parse(fs.readFileSync(process.argv[1], 'utf-8'));
  let visualByPath = {};
  if (process.argv[2]) {
    try {
      const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
      for (const p of d.pages || []) visualByPath[p.path] = p.status;
    } catch {}
  }
  const order = [
    ...(c.changed || []).map(p => [p, 'CHANGED']),
    ...(c.new || []).map(p => [p, 'NEW']),
    ...(c.unchanged || []).map(p => [p, 'UNCHANGED']),
  ];
  for (const [p, kind] of order) {
    const visual = (visualByPath[p] || (kind === 'NEW' ? 'new' : 'identical')).toUpperCase();
    console.log([p, kind, visual].join('\t'));
  }
" "$CHANGES_FILE" "$DIFFS_FILE" >"${TEMP_DIR}/pages.tsv"

SEGMENT_INDEX=0
: >"${TEMP_DIR}/concat.txt"

while IFS=$'\t' read -r PAGE_PATH CHANGE_TYPE VISUAL_STATUS; do
  [ -z "$PAGE_PATH" ] && continue

  SAFE_NAME=$(echo "$PAGE_PATH" | sed 's|/|_|g; s|^_||; s|_$||')
  [ -z "$SAFE_NAME" ] && SAFE_NAME="index"

  PR_IMG="${PR_DIR}/${SAFE_NAME}.png"
  PROD_IMG="${PROD_DIR}/${SAFE_NAME}.png"

  [ ! -f "$PR_IMG" ] && continue
  [ ! -f "$PROD_IMG" ] && continue

  SEGMENT_FILE="${TEMP_DIR}/segment_$(printf '%04d' $SEGMENT_INDEX).mp4"

  # Top-of-frame indicator: red for VISUALLY DIFFERENT, green for
  # VISUALLY IDENTICAL, blue for NEW PAGE. This is the "did this page
  # actually change" signal — distinct from the changeset-derived
  # CHANGED/NEW/UNCHANGED tag, which only says "the diff *could* affect
  # this page".
  case "$VISUAL_STATUS" in
    DIFFERENT)
      INDICATOR_TEXT="VISUALLY DIFFERENT"
      INDICATOR_BG="#c2243d"
      INDICATOR_FG="white"
      ;;
    NEW)
      INDICATOR_TEXT="NEW PAGE"
      INDICATOR_BG="#285aff"
      INDICATOR_FG="white"
      ;;
    IDENTICAL | *)
      INDICATOR_TEXT="VISUALLY IDENTICAL"
      INDICATOR_BG="#1a8e54"
      INDICATOR_FG="white"
      ;;
  esac

  # Escape special chars for ffmpeg drawtext: backslashes, colons, quotes,
  # apostrophes. Order matters — backslashes first.
  PAGE_LABEL=$(printf '%s' "$PAGE_PATH" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' -e "s/'/\\\\'/g")

  # Full prod URL for the page (APEX_DOMAIN is the consuming site's apex,
  # e.g. adamdaniel.ai), shown as a second line under the page path so a
  # reviewer can read/open the exact URL. `set -u` is on, so default the
  # var. Escaped for drawtext the same way as PAGE_LABEL.
  _apex="${APEX_DOMAIN:-}"
  if [ -n "$_apex" ]; then
    FULL_URL="https://${_apex}${PAGE_PATH}"
  else
    FULL_URL="${PAGE_PATH}"
  fi
  FULL_URL_LABEL=$(printf '%s' "$FULL_URL" | sed -e 's/\\/\\\\/g' -e 's/:/\\:/g' -e "s/'/\\\\'/g")

  # Side panels scaled with letterboxing, hstacked, padded into the full
  # frame so the top 80px is reserved for the indicator bar.
  # -nostdin: this loop reads pages.tsv on stdin; ffmpeg must not swallow it.
  ffmpeg -nostdin -y -loglevel warning \
    -loop 1 -t 3 -i "$PROD_IMG" \
    -loop 1 -t 3 -i "$PR_IMG" \
    -filter_complex "
      [0:v]scale=${SIDE_W}:${SIDE_H}:force_original_aspect_ratio=decrease,pad=${SIDE_W}:${SIDE_H}:(ow-iw)/2:(oh-ih)/2:color=#04060f[left];
      [1:v]scale=${SIDE_W}:${SIDE_H}:force_original_aspect_ratio=decrease,pad=${SIDE_W}:${SIDE_H}:(ow-iw)/2:(oh-ih)/2:color=#04060f[right];
      [left][right]hstack=inputs=2[combined];
      [combined]pad=${WIDTH}:${HEIGHT}:(ow-iw)/2:${TOP_BAR_H}:color=#04060f[padded];
      [padded]
        drawbox=x=0:y=0:w=${WIDTH}:h=${TOP_BAR_H}:color=${INDICATOR_BG}:t=fill,
        drawtext=text='${INDICATOR_TEXT}':fontsize=42:fontcolor=${INDICATOR_FG}:x=(w-text_w)/2:y=(${TOP_BAR_H}-text_h)/2:fontfile=${FONT},
        drawtext=text='PRODUCTION':fontsize=20:fontcolor=#d8e4ff:box=1:boxcolor=#04060f:boxborderw=8:x=40:y=${TOP_BAR_H}+15:fontfile=${FONT},
        drawtext=text='PR \#${PR_NUMBER}':fontsize=20:fontcolor=#d8e4ff:box=1:boxcolor=#04060f:boxborderw=8:x=w-tw-40:y=${TOP_BAR_H}+15:fontfile=${FONT},
        drawtext=text='${CHANGE_TYPE} in changeset':fontsize=16:fontcolor=#8ab0e8:box=1:boxcolor=#04060f:boxborderw=6:x=(w-text_w)/2:y=h-96:fontfile=${FONT_REGULAR},
        drawtext=text='${PAGE_LABEL}':fontsize=18:fontcolor=#d8e4ff:box=1:boxcolor=#04060f:boxborderw=6:x=(w-text_w)/2:y=h-62:fontfile=${FONT_REGULAR},
        drawtext=text='${FULL_URL_LABEL}':fontsize=16:fontcolor=#8ab0e8:box=1:boxcolor=#04060f:boxborderw=6:x=(w-text_w)/2:y=h-28:fontfile=${FONT_REGULAR}
    " \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -r 2 "$SEGMENT_FILE"

  echo "file '${SEGMENT_FILE}'" >>"${TEMP_DIR}/concat.txt"
  SEGMENT_INDEX=$((SEGMENT_INDEX + 1))
done <"${TEMP_DIR}/pages.tsv"

if [ -s "${TEMP_DIR}/concat.txt" ]; then
  ffmpeg -y -loglevel warning \
    -f concat -safe 0 -i "${TEMP_DIR}/concat.txt" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$OUTPUT"
  echo "Video generated: $OUTPUT (${SEGMENT_INDEX} pages)"
else
  ffmpeg -y -loglevel warning \
    -f lavfi -i "color=c=#04060f:s=${WIDTH}x${HEIGHT}:d=3" \
    -vf "drawtext=text='No pages to compare':fontsize=42:fontcolor=#d8e4ff:x=(w-text_w)/2:y=(h-text_h)/2:fontfile=${FONT}" \
    -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p "$OUTPUT"
  echo "No pages to compare — placeholder video generated."
fi

rm -rf "$TEMP_DIR"
