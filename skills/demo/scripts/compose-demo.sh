#!/usr/bin/env bash
# compose-demo.sh — composite a raw browser screen recording into a titled,
# size-capped demo mp4 using ffmpeg only (NO Remotion, NO headless render).
#
# Used by the `/demo` workflow: agent-browser records the session to a .webm,
# this script turns it into a polished, GitHub-embeddable mp4.
#
# Usage:
#   compose-demo.sh --output demo.mp4 --title "PR #42 — Add dark mode" \
#     [--subtitle "..."] [--layout single|side-by-side] \
#     [--labels "BEFORE (main)" "AFTER (PR)"] [--speed 1.5] \
#     [--trim START:END] [--target-size-mb 10] [--crf 18] \
#     [--width 1920] [--height 1080] [--title-secs 2.5] <clip1.webm> [clip2.webm]
#
# What it does:
#   1. Normalizes each input clip (optional trim, speed-up, scale+pad to the
#      panel size with lanczos, fps/pixfmt/SAR normalize, optional per-panel
#      label).
#   2. Lays out the body: a single panel, or two panels side-by-side (hstack).
#   3. Prepends a title/subtitle card (solid bg + drawtext).
#   4. Quality-first H.264 encode: a single-pass CRF encode (sharp for UI
#      screencasts) that usually lands well under --target-size-mb; only if it
#      overshoots does it fall back to a size-targeted two-pass ABR encode.
#      yuv420p + +faststart for web streaming.
#   5. Prints an ffprobe summary (resolution / duration / size).
#
# Prerequisites: ffmpeg, ffprobe (baked into lastlight-sandbox-qa:latest).
# Runs fully offline.

set -euo pipefail

die() { echo "compose-demo.sh: error: $*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"; }
require_cmd ffmpeg
require_cmd ffprobe

# ── Defaults ────────────────────────────────────────────────────────────────
OUTPUT=""
TITLE=""
SUBTITLE=""
LAYOUT="single"
LABEL1=""
LABEL2=""
SPEED="1"
TRIM=""
TARGET_MB="10"
CRF="18"
WIDTH="1920"
HEIGHT="1080"
TITLE_SECS="2.5"
CLIPS=()

# ── Parse args ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2;;
    --title) TITLE="$2"; shift 2;;
    --subtitle) SUBTITLE="$2"; shift 2;;
    --layout) LAYOUT="$2"; shift 2;;
    --labels) LABEL1="$2"; LABEL2="$3"; shift 3;;
    --speed) SPEED="$2"; shift 2;;
    --trim) TRIM="$2"; shift 2;;
    --target-size-mb) TARGET_MB="$2"; shift 2;;
    --crf) CRF="$2"; shift 2;;
    --width) WIDTH="$2"; shift 2;;
    --height) HEIGHT="$2"; shift 2;;
    --title-secs) TITLE_SECS="$2"; shift 2;;
    -*) die "unknown flag: $1";;
    *) CLIPS+=("$1"); shift;;
  esac
done

[[ -n "$OUTPUT" ]] || die "--output is required"
[[ ${#CLIPS[@]} -ge 1 ]] || die "at least one input clip is required"
for c in "${CLIPS[@]}"; do [[ -f "$c" ]] || die "clip not found: $c"; done
if [[ "$LAYOUT" == "side-by-side" ]]; then
  [[ ${#CLIPS[@]} -ge 2 ]] || die "side-by-side layout needs two clips"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/compose-demo-XXXXXX")"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ── Font for drawtext ────────────────────────────────────────────────────────
# Prefer an explicit fontfile (Liberation ships in the QA image via
# fonts-liberation); fall back to fontconfig's default Sans family.
FONT="${DEMO_FONT:-}"
if [[ -z "$FONT" ]]; then
  for f in \
    /usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf \
    /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf; do
    [[ -f "$f" ]] && FONT="$f" && break
  done
fi
if [[ -n "$FONT" ]]; then FONTARG="fontfile=${FONT}"; else FONTARG="font=Sans"; fi

# drawtext drives the title card and per-panel labels. The Debian `ffmpeg`
# package (the QA image) is built with libfreetype so it's present; but degrade
# gracefully on a build without it (omit text overlays) rather than failing the
# whole compose — the demo video is still worth shipping.
HAS_DRAWTEXT=0
# Detect the drawtext filter WITHOUT a pipe. Under `set -o pipefail`, any
# `ffmpeg -filters | grep -q drawtext` (or even `printf "$var" | grep -q`) is a
# false-negative trap: `grep -q` exits on the first match and closes the pipe,
# the writer (still emitting — `drawtext` sits ~16 KB into ~38 KB of output)
# dies with SIGPIPE (141), and `pipefail` promotes that to the pipeline's exit
# status, so the `if` wrongly concludes drawtext is absent (~19 of 20 runs).
# Capture into a variable and match with a pure bash `case` — no subprocess,
# no pipe, no SIGPIPE.
FFMPEG_FILTERS="$(ffmpeg -hide_banner -filters 2>/dev/null || true)"
case "$FFMPEG_FILTERS" in
  *drawtext*) HAS_DRAWTEXT=1 ;;
  *) echo "compose-demo.sh: warning: this ffmpeg lacks the drawtext filter — title card and labels omitted." >&2 ;;
esac

# Panel size: side-by-side splits the width into two equal panels.
PH="$HEIGHT"
if [[ "$LAYOUT" == "side-by-side" ]]; then PW=$(( WIDTH / 2 )); else PW="$WIDTH"; fi

# ── Stage A: normalize one clip into a body panel ─────────────────────────────
# Args: <input> <outfile> <label-file-or-empty> <apply-trim:0|1>
build_panel() {
  local input="$1" outfile="$2" labelfile="$3" apply_trim="$4"
  local trim_args=()
  if [[ "$apply_trim" == "1" && -n "$TRIM" ]]; then
    local start="${TRIM%%:*}" end="${TRIM##*:}"
    [[ -n "$start" ]] && trim_args+=(-ss "$start")
    [[ -n "$end" ]] && trim_args+=(-to "$end")
  fi
  local vf="setpts=PTS/${SPEED}"
  vf+=",scale=${PW}:${PH}:force_original_aspect_ratio=decrease:flags=lanczos"
  vf+=",pad=${PW}:${PH}:(ow-iw)/2:(oh-ih)/2:color=black"
  vf+=",fps=30,format=yuv420p,setsar=1"
  if [[ -n "$labelfile" && "$HAS_DRAWTEXT" == "1" ]]; then
    vf+=",drawtext=${FONTARG}:textfile=${labelfile}:x=(w-text_w)/2:y=h-th-24"
    vf+=":fontsize=26:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=12"
  fi
  # `${arr[@]+"${arr[@]}"}` expands to nothing when the array is empty without
  # tripping `set -u` (an empty `"${arr[@]}"` errors on bash < 4.4, e.g. macOS).
  ffmpeg -y -loglevel error ${trim_args[@]+"${trim_args[@]}"} -i "$input" \
    -vf "$vf" -an -c:v libx264 -crf "$CRF" -preset medium "$outfile"
}

# Per-panel labels (side-by-side) written to files to avoid drawtext escaping.
LABELFILE1=""; LABELFILE2=""
if [[ "$LAYOUT" == "side-by-side" ]]; then
  if [[ -n "$LABEL1" ]]; then LABELFILE1="$WORK/label1.txt"; printf '%s' "$LABEL1" > "$LABELFILE1"; fi
  if [[ -n "$LABEL2" ]]; then LABELFILE2="$WORK/label2.txt"; printf '%s' "$LABEL2" > "$LABELFILE2"; fi
fi

echo "compose-demo.sh: normalizing clips (layout=$LAYOUT, speed=${SPEED}x)…" >&2
build_panel "${CLIPS[0]}" "$WORK/panel0.mp4" "$LABELFILE1" 1
BODY="$WORK/body.mp4"
if [[ "$LAYOUT" == "side-by-side" ]]; then
  build_panel "${CLIPS[1]}" "$WORK/panel1.mp4" "$LABELFILE2" 1
  ffmpeg -y -loglevel error -i "$WORK/panel0.mp4" -i "$WORK/panel1.mp4" \
    -filter_complex "[0:v][1:v]hstack=inputs=2,format=yuv420p,setsar=1[v]" \
    -map "[v]" -an -c:v libx264 -crf "$CRF" -preset medium "$BODY"
else
  BODY="$WORK/panel0.mp4"
fi

# ── Stage B: title card (skipped when drawtext is unavailable) ───────────────
TITLE_CLIP=""
TITLE_DUR="0"
if [[ "$HAS_DRAWTEXT" == "1" ]]; then
  TITLEFILE="$WORK/title.txt"; printf '%s' "${TITLE:-Demo}" > "$TITLEFILE"
  TITLE_VF="drawtext=${FONTARG}:textfile=${TITLEFILE}:x=(w-text_w)/2:y=(h/2)-th-10:fontsize=48:fontcolor=white"
  if [[ -n "$SUBTITLE" ]]; then
    SUBFILE="$WORK/subtitle.txt"; printf '%s' "$SUBTITLE" > "$SUBFILE"
    TITLE_VF+=",drawtext=${FONTARG}:textfile=${SUBFILE}:x=(w-text_w)/2:y=(h/2)+10:fontsize=26:fontcolor=0xb0b0b0"
  fi
  TITLE_VF+=",format=yuv420p"
  ffmpeg -y -loglevel error -f lavfi -i "color=c=0x101418:s=${WIDTH}x${HEIGHT}:d=${TITLE_SECS}:r=30" \
    -vf "$TITLE_VF" -c:v libx264 -crf "$CRF" -preset medium "$WORK/title.mp4"
  TITLE_CLIP="$WORK/title.mp4"
  TITLE_DUR="$TITLE_SECS"
fi

# ── Stage C: (concat title +) body → final mp4 ───────────────────────────────
# With a title card: concat it ahead of the body. Without: pass the body
# through (`null`) so the same encode applies either way.
if [[ -n "$TITLE_CLIP" ]]; then
  IN_ARGS=(-i "$TITLE_CLIP" -i "$BODY")
  FILTER='[0:v][1:v]concat=n=2:v=1:a=0[v]'
else
  IN_ARGS=(-i "$BODY")
  FILTER='[0:v]null[v]'
fi

# Quality-first: a single-pass CRF encode (visually crisp for UI screencasts —
# constant quality, not a starved average bitrate) usually lands well under the
# size cap. The old always-two-pass-ABR path starved short, near-static clips
# down to a few tens of KB; CRF spends the bits the content needs.
echo "compose-demo.sh: encoding (crf ${CRF}, preset slow)…" >&2
ffmpeg -y -loglevel error "${IN_ARGS[@]}" \
  -filter_complex "$FILTER" -map "[v]" -an \
  -c:v libx264 -crf "$CRF" -preset slow \
  -pix_fmt yuv420p -movflags +faststart "$OUTPUT"

# Size cap: only if the quality encode overshoots --target-size-mb do we redo it
# as a size-targeted two-pass ABR encode (keeps it under GitHub's inline limit).
OUT_BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
CAP_BYTES="$(awk -v mb="$TARGET_MB" 'BEGIN{printf "%d", mb*1024*1024}')"
if [[ "$OUT_BYTES" -gt "$CAP_BYTES" ]]; then
  BODY_DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$BODY" || echo 0)"
  TOTAL_DUR="$(awk -v a="$TITLE_DUR" -v b="$BODY_DUR" 'BEGIN{printf "%.3f", a + b}')"
  # Target video bitrate (kbit/s) = target_bytes * 8 / duration / 1000, with a
  # small headroom factor for the muxer; floored so very short clips still encode.
  BR_K="$(awk -v mb="$TARGET_MB" -v d="$TOTAL_DUR" 'BEGIN{
    if (d <= 0) d = 1;
    br = (mb * 1024 * 1024 * 8) / d / 1000 * 0.92;
    if (br < 200) br = 200;
    printf "%d", br;
  }')"
  PASSLOG="$WORK/ff2pass"
  echo "compose-demo.sh: crf encode was $(awk -v b="$OUT_BYTES" 'BEGIN{printf "%.1f", b/1024/1024}')MB > ${TARGET_MB}MB cap — re-encoding size-capped (${TOTAL_DUR}s → ${BR_K}kbit/s, two-pass)…" >&2
  ffmpeg -y -loglevel error "${IN_ARGS[@]}" \
    -filter_complex "$FILTER" -map "[v]" -an \
    -c:v libx264 -b:v "${BR_K}k" -pass 1 -passlogfile "$PASSLOG" -preset medium -f mp4 /dev/null
  ffmpeg -y -loglevel error "${IN_ARGS[@]}" \
    -filter_complex "$FILTER" -map "[v]" -an \
    -c:v libx264 -b:v "${BR_K}k" -pass 2 -passlogfile "$PASSLOG" -preset medium \
    -pix_fmt yuv420p -movflags +faststart "$OUTPUT"
fi

# ── Stage D: report ───────────────────────────────────────────────────────────
RES="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x "$OUTPUT" || echo '?')"
DUR="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUTPUT" || echo '?')"
BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
MB="$(awk -v b="$BYTES" 'BEGIN{printf "%.2f", b/1024/1024}')"
echo "compose-demo.sh: wrote $OUTPUT  (${RES}, ${DUR}s, ${MB}MB)" >&2
# Machine-readable line for the agent to parse.
echo "{\"output\":\"${OUTPUT}\",\"resolution\":\"${RES}\",\"duration\":\"${DUR}\",\"size_mb\":${MB}}"
