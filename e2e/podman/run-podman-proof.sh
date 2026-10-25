#!/bin/bash
# Prove that an imp host runs with no Docker engine. The script starts the
# dev instance under Docker, makes an imp and lets impd fetch its builder
# image, then stops the instance, masks the host's Docker, and starts the
# instance again under rootful Podman on the same data dir. It checks that
# the data dir and the builder image survive the switch. Last, it starts a
# Podman instance on a fresh data dir, which fetches its own builder image,
# and runs the socket and podman e2e suites on it.
#
#   sudo -E env "PATH=$PATH" e2e/podman/run-podman-proof.sh
#
# It masks docker.service and docker.socket and does not unmask them, so it
# runs only where CI=true says the machine is a throwaway runner. It needs
# IMP_HOST_IMAGE, the tag of a host image in Docker's store, and the kernel
# and system drive that IMP_KERNEL and IMP_SYSTEM_DRIVE name.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DEV="$ROOT/scripts/dev/dev.sh"
IMPZ="$ROOT/scripts/impz"
CONTAINER=${IMP_DEV_NAME:-imp-dev}
KEEP=e2e-podman-keep
MARKER=/root/podman-proof
MARKER_TEXT=written-under-docker
LOG_DIR="$ROOT/.cache/e2e"
CHECKED=()

fail() {
  echo "run-podman-proof: $1" >&2
  exit 1
}

pass() {
  CHECKED+=("$1")
  echo "    ok: $1"
}

run_impz() {
  IMP_URL="http://localhost:$((7070 + ${IMP_DEV_PORT_OFFSET:-0}))" IMP_TOKEN="$TOKEN" "$IMPZ" "$@"
}

read_image_field() {
  run_impz image ls --json | jq -r --arg name "$1" --arg field "$2" \
    '.[] | select(.name == $name) | .[$field]'
}

wait_for_image() {
  local deadline=$((SECONDS + 900))

  until [ -n "$(read_image_field "$1" id)" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      fail "impd added no $1 image in 900 s"
    fi
    sleep 5
  done
}

[ "$(id -u)" = 0 ] || fail "run as root: it masks the host's Docker and runs rootful Podman"
[ "${CI:-}" = true ] || fail "it masks the host's Docker for good; run it only on a CI runner (CI=true)"
[ -n "${IMP_HOST_IMAGE:-}" ] || fail "IMP_HOST_IMAGE must name the host image in Docker's store"
command -v podman >/dev/null || fail "no podman on PATH"
command -v jq >/dev/null || fail "no jq on PATH"
mkdir -p "$LOG_DIR"

echo "== under Docker"
IMP_DEV_CONTAINER_CLI=docker "$DEV" up
TOKEN=$(IMP_DEV_CONTAINER_CLI=docker "$DEV" token)
wait_for_image imp-builder
wait_for_image ubuntu
builder_before="$(read_image_field imp-builder id) $(read_image_field imp-builder digest)"
run_impz new "$KEEP" --image ubuntu >/dev/null
run_impz exec "$KEEP" -- sh -c "echo $MARKER_TEXT > $MARKER"
echo "    $KEEP holds $MARKER; imp-builder is $builder_before"
docker logs "$CONTAINER" >"$LOG_DIR/impd-docker.log" 2>&1 || true
IMP_DEV_CONTAINER_CLI=docker "$DEV" down

echo "== the host image into Podman, then Docker off"
docker save "$IMP_HOST_IMAGE" | podman load
podman image exists "$IMP_HOST_IMAGE" || fail "podman load gave no $IMP_HOST_IMAGE image"
systemctl mask --now docker.socket docker.service

# A stopped socket unit leaves its socket file behind unless the unit sets RemoveOnStop.
rm -f /var/run/docker.sock
[ ! -e /var/run/docker.sock ] || fail "/var/run/docker.sock is still there"
pass "the host has no /var/run/docker.sock"
if docker info >/dev/null 2>&1; then
  fail "docker info still reaches an engine"
fi
pass "docker info reaches no engine"

echo "== under Podman, on the same data dir"
export IMP_DEV_CONTAINER_CLI=podman
"$DEV" up
TOKEN=$("$DEV" token)
podman exec "$CONTAINER" sh -c '[ ! -e /var/run/docker.sock ] && ! command -v docker' ||
  fail "$CONTAINER has a Docker socket or a docker binary"
pass "$CONTAINER has no Docker socket and no docker binary"
# podman inspect shows the limit the container was given, so --pids-limit=-1
# shows as -1; without the flag it shows containers.conf's default, 2048.
pids_limit=$(podman inspect -f '{{.HostConfig.PidsLimit}}' "$CONTAINER")
[ "$pids_limit" = -1 ] || fail "$CONTAINER has pids limit $pids_limit, not -1"
pids_max=$(podman exec "$CONTAINER" cat /sys/fs/cgroup/pids.max) ||
  fail "$CONTAINER has no pids.max in its cgroup"
[ "$pids_max" = max ] || fail "$CONTAINER's cgroup caps its processes at $pids_max"
pass "$CONTAINER runs with no pids limit"
# An image unpack writes the image's device nodes under /var/lib/imp/images,
# which the engine's device cgroup rules must allow.
podman exec "$CONTAINER" sh -c 'd=$(mktemp -d -p /var/lib/imp/images) &&
  mknod "$d/null" c 1 3 && test -c "$d/null" &&
  mknod "$d/loop" b 7 0 && test -b "$d/loop" && rm -rf "$d"' ||
  fail "$CONTAINER cannot make device nodes under /var/lib/imp/images"
pass "$CONTAINER makes character and block device nodes under /var/lib/imp/images"
run_impz ls --json | jq -e --arg name "$KEEP" 'any(.[]; .name == $name)' >/dev/null ||
  fail "impd no longer lists $KEEP"
pass "impd lists $KEEP, which it made under Docker"
marker=$(run_impz exec "$KEEP" -- cat "$MARKER")
[ "$marker" = "$MARKER_TEXT" ] || fail "$KEEP's $MARKER holds '$marker', not '$MARKER_TEXT'"
pass "$KEEP's $MARKER still holds $MARKER_TEXT"
builder_after="$(read_image_field imp-builder id) $(read_image_field imp-builder digest)"
[ "$builder_after" = "$builder_before" ] ||
  fail "imp-builder is $builder_after, not $builder_before: impd fetched it again"
pass "imp-builder is the image impd fetched under Docker: $builder_after"
run_impz rm "$KEEP" >/dev/null
"$DEV" down

# A fresh data dir, so impd fetches its builder image on a host that never ran Docker for it.
echo "== under Podman, on a fresh data dir"
export IMP_DEV_DATA="${IMP_DEV_DATA:-$ROOT/.data/dev}-fresh"
mkdir -p "$IMP_DEV_DATA"
"$DEV" up
TOKEN=$("$DEV" token)
wait_for_image imp-builder
pass "impd fetched imp-builder under Podman, with Docker masked: $(read_image_field imp-builder digest)"

echo "== the socket and podman suites under Podman"
"$ROOT/e2e/test-e2e.sh" --only socket,podman
pass "the socket and podman suites pass under Podman"

echo "== run-podman-proof checked"
printf '    %s\n' "${CHECKED[@]}"
