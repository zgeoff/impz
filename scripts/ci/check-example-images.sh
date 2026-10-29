#!/bin/bash
# Check the Dockerfile of each image in images/examples: it starts from the
# published base, pinned by digest, and each file it downloads with curl is
# checked by sha256sum against a sum that an ARG pins.
#
#   scripts/ci/check-example-images.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

status=0
fail() {
  echo "check-example-images: $*" >&2
  status=1
}

for dockerfile in images/examples/*/Dockerfile; do
  # Docker drops a comment line, inside a RUN's continuation lines too
  code=$(grep -v '^[[:space:]]*#' "$dockerfile" || true)

  froms=$(grep -iE '^FROM[[:space:]]' <<< "$code" || true)
  if ! grep -qxE 'FROM ghcr\.io/zgeoff/imp-base:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}' <<< "$froms" ||
    [ "$(wc -l <<< "$froms")" != 1 ]; then
    fail "$dockerfile must have one FROM, ghcr.io/zgeoff/imp-base:<tag>@sha256:<digest>"
  fi

  curls=$(grep -oE 'curl [^;|&]*' <<< "$code" || true)
  [ -n "$curls" ] || continue
  while read -r curl; do
    if ! download=$(grep -oE ' -[A-Za-z]*o [^ ]+' <<< "$curl" | sed 's/.* //'); then
      fail "$dockerfile runs a curl that writes no file to check: $curl"
      continue
    fi
    sum_args=$({ grep -F "  $download\" | sha256sum -c -" <<< "$code" || true; } |
      sed -nE 's/.*echo "[$]([A-Z0-9_]+_SHA256)  .*/\1/p')
    sum_arg=${sum_args%%$'\n'*}
    if [ -z "$sum_arg" ] || ! grep -qxE "ARG $sum_arg=[0-9a-f]{64}" <<< "$code"; then
      fail "$dockerfile downloads $download with no sha256sum -c against a pinned ARG"
    fi
  done <<< "$curls"
done

if [ "$status" = 0 ]; then
  echo "check-example-images: every example starts from the pinned base and checks its downloads"
fi
exit "$status"
