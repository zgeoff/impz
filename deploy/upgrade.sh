#!/bin/bash
# Upgrade the imp host to a new release image without losing imps.
#
#   deploy/upgrade.sh
#
# A host on an older release gets this script, with the deploy/lib/host-env.sh
# it sources, from the new image, not from its own release
# (docs/guides/operations.md#upgrade):
#
#   podman run --rm <new image> tar -cf - -C /usr/local/share/imp deploy | tar -xf -
#   deploy/upgrade.sh
#
# The unit runs imp-host with Podman. A host whose imp-host runs under Docker,
# as the releases before did, moves to Podman here: step 3 says how.
#
# 1. Pulls the image with Podman: this script's own release, unless
#    IMP_HOST_IMAGE (the environment, then the env file) names another. When a
#    Podman host already runs it, step 3 still installs the image lines and
#    files and retires imp-docker-proxy, and restarts nothing else. Refuses an
#    image that the restarted unit would not run (drop-ins count), and an env
#    file with IMP_HOST_IMAGE= empty. Refuses an image whose imp.host-contract
#    is not no-docker: it needs a Docker socket, which a Podman host does not
#    give. Reads the image's seccomp profile and unit; one it cannot read, or
#    reads empty, stops the upgrade here, and so does a unit that does not run
#    Podman.
# 2. Sleeps every awake imp through the API, one at a time, and stops on the
#    first that fails: the host keeps running the old image, untouched.
#    Stopping the container would sleep them too, but within its 120 s.
# 3. On a Docker host: stops imp-host with the old unit, removes its container,
#    stops and disables imp-docker-proxy, whose unit becomes .bak-<time>, and
#    with IPv6 removes Docker's imp-host network, so the new unit's Podman
#    makes its own on the same /64 and bridge. Then, on any host, installs the
#    image's seccomp profile and systemd unit by rename, keeping a changed unit
#    as .bak-<time>, stops and disables an imp-docker-proxy that a Podman host
#    still has, as on a Docker host, and starts or restarts imp-host on the new
#    image and waits for impd. /var/lib/imp and the env file's values stay, and
#    so does Docker. Local changes to a unit belong in a drop-in
#    (imp-host.service.d/), which stays. First, an env file line
#    IMP_HOST_IMAGE=...:latest, as every env file had before the units named
#    their release, is the old template's, not a pin: it becomes a comment, and
#    the file before is kept as .bak-<time>. Installed units and files lose the
#    release-please marker lines.
# 4. Prints how to roll back, how many imps will boot cold and how many run
#    outdated parts, then lists the imps: a NOTE says which boot cold on
#    their next wake, and why (docs/guides/operations.md#upgrade).
#
# Needs podman, curl and jq on the host, and docker to move a Docker host.
#
# Env: IMP_HOST_IMAGE (default: from IMP_HOST_ENV_FILE, else this script's
#      release) must be the image the unit runs.
#      IMP_HOST_ENV_FILE defaults to /etc/imp/imp-host.env.
#      IMP_HOST_UNIT_FILE defaults to /etc/systemd/system/imp-host.service,
#      IMP_DOCKER_PROXY_UNIT_FILE, the unit a Docker host may still have, to
#      /etc/systemd/system/imp-docker-proxy.service, IMP_HOST_SECCOMP_FILE to
#      /etc/imp/imp-host.seccomp.json.
#      IMP_READY_TIMEOUT_S (default 120) is how long impd gets to answer ready.
set -euo pipefail

# the functions bootstrap.sh and the NixOS module share, beside this script
# in the image and in a checkout; no dirname, which a host may lack, as the
# tool checks below allow
here=${BASH_SOURCE[0]%/*}
[ "$here" != "${BASH_SOURCE[0]}" ] || here=.
host_env=$here/lib/host-env.sh
if [ ! -r "$host_env" ]; then
  echo "upgrade: no $host_env beside this script; take both from the new image: podman run --rm <new image> tar -cf - -C /usr/local/share/imp deploy | tar -xf -, then run deploy/upgrade.sh (docs/guides/operations.md#upgrade)" >&2
  exit 1
fi
# shellcheck source=deploy/lib/host-env.sh
. "$host_env"

container=imp-host
env_file=${IMP_HOST_ENV_FILE:-/etc/imp/imp-host.env}
unit_file=${IMP_HOST_UNIT_FILE:-/etc/systemd/system/imp-host.service}
proxy_unit_file=${IMP_DOCKER_PROXY_UNIT_FILE:-/etc/systemd/system/imp-docker-proxy.service}
seccomp_file=${IMP_HOST_SECCOMP_FILE:-/etc/imp/imp-host.seccomp.json}
ready_timeout_s=${IMP_READY_TIMEOUT_S:-120}
image_deploy=/usr/local/share/imp/deploy
health=http://127.0.0.1:7070/health
# The image of this script's release, as its units name it; release-please
# bumps it.
readonly release_image=ghcr.io/zgeoff/imp-host:4.2.4 # x-release-please-version
# The image line every env file had before the units named their release.
readonly legacy_image_line=IMP_HOST_IMAGE=ghcr.io/zgeoff/imp-host:latest

case ${1:-} in
  '') ;;
  --compose)
    echo "upgrade: the Compose recipe is gone; the systemd unit that deploy/bootstrap.sh installs replaces it (docs/guides/install.md). Nothing changed." >&2
    exit 1
    ;;
  *)
    echo "usage: $0" >&2
    exit 2
    ;;
esac

# the env file's pin, or nothing: its last non-empty IMP_HOST_IMAGE line
# that is not the legacy one, which migrate_env_file turns into a comment
pinned_image() {
  local line
  line=$(trim_lines "$env_file" | grep -E '^IMP_HOST_IMAGE=.' | grep -vxF "$legacy_image_line" | tail -n 1 || true)
  echo "${line#IMP_HOST_IMAGE=}"
}

# the image to move to: the environment, then the env file's pin, then this
# script's release
read_image() {
  if [ -n "${IMP_HOST_IMAGE:-}" ]; then
    echo "$IMP_HOST_IMAGE"
    return
  fi
  pinned_image | grep . || echo "$release_image"
}

# the IMP_HOST_IMAGE that the Environment= lines of FILE... set, the last
# one winning. A line may set several, each one in double quotes or not.
environment_image() {
  sed -n 's/^Environment=//p' "$@" 2>/dev/null | xargs -n 1 2>/dev/null |
    sed -n 's/^IMP_HOST_IMAGE=//p' | tail -n 1 || true
}

# unit_image UNIT INSTALLED: the image a unit runs after the restart: the env
# file's pin, else the default that UNIT (the new one when the image gives
# it) or a drop-in of INSTALLED sets; empty when none sets one
unit_image() {
  local pin
  pin=$(pinned_image)
  if [ -n "$pin" ]; then
    echo "$pin"
    return
  fi
  environment_image "$1" "$2".d/*.conf
}

# a timestamp for the .bak-<time> files
backup_time() { date +%Y%m%d-%H%M%S; }

# Set once a Docker host's imp-host stops, and as each step of the move
# changes the host, for the rollback steps that format_docker_rollback gives
stopped=
network_removed=
started=
unit_backup=
proxy_backup=

# the rollback steps from Podman back to the Docker host, for what the move
# has changed so far
format_docker_rollback() {
  local steps=("systemctl stop $container")
  # Podman makes its network as imp-host starts; the old unit makes Docker's
  [ -z "$network_removed" ] || [ -z "$started" ] || steps+=("podman network rm $HOST_NETWORK")
  [ -z "$unit_backup" ] || steps+=("mv $unit_backup $unit_file")
  [ -z "$proxy_backup" ] || steps+=("mv $proxy_backup $proxy_unit_file")
  steps+=("systemctl daemon-reload")
  # The env file may pin the new image, which Docker would pull and start;
  # the proxy reads the same pin, and the new image has no proxy binary.
  local runs
  runs=$(docker_unit_image)
  [ -z "$runs" ] || steps+=("docker tag $old $runs")
  [ -z "$proxy_backup" ] || steps+=("systemctl enable --now imp-docker-proxy")
  steps+=("systemctl start $container")
  local text=${steps[0]} step
  for step in "${steps[@]:1}"; do text+=", then $step"; done
  echo "$text"
}

# the image the Docker unit runs once it is back: the env file's last
# IMP_HOST_IMAGE, else the default that the unit or a drop-in sets
docker_unit_image() {
  local line
  line=$(trim_lines "$env_file" | grep -E '^IMP_HOST_IMAGE=.' | tail -n 1 || true)
  if [ -n "$line" ]; then
    echo "${line#IMP_HOST_IMAGE=}"
    return
  fi
  environment_image "${unit_backup:-$unit_file}" "$unit_file".d/*.conf
}

# what a failed step leaves: the old host running, or, once a Docker host's
# imp-host stops, the steps that bring it back
format_host_state() {
  if [ -n "$stopped" ]; then
    echo "imp-host is stopped; to roll back to Docker: $(format_docker_rollback)"
  else
    echo "nothing restarted, the host still runs $old"
  fi
}

# rewrite_file PATH AWK_PROGRAM [AWK_ARGS...]: PATH through awk, by rename,
# with the old PATH kept as PATH.bak-<time>, named in $backup. The env file
# holds secrets: the backup is 0600, and the new PATH keeps PATH's mode.
# Exits on a failure, before anything restarts.
rewrite_file() {
  local path=$1
  shift
  backup=$path.bak-$(backup_time)
  if ! { (umask 077 && cp "$path" "$backup") && chmod 600 "$backup" && cp -p "$path" "$path.new" &&
    awk "$@" "$backup" >"$path.new" && mv "$path.new" "$path"; }; then
    rm -f "$path.new"
    echo "upgrade: cannot rewrite $path; $(format_host_state)" >&2
    exit 1
  fi
}

# The legacy line becomes the commented pin, as in the env template: the
# units then run their release's image. Any other value is a pin and stays.
migrate_env_file() {
  trim_lines "$env_file" | grep -qxF "$legacy_image_line" || return 0
  # shellcheck disable=SC2016 # an awk program
  rewrite_file "$env_file" -v q="'" -v legacy="$legacy_image_line" -v pin="# IMP_HOST_IMAGE=$release_image" "$TRIM_AWK"'
    trim($0) == legacy { print pin; next }
    { print }'
  echo "upgrade: $env_file: $legacy_image_line was the old template's line, not a pin; it is a comment now, and the units run their release's image (the file before: $backup)"
}

# The CLI in the running container: impz, or imp in an image from before the
# CLI's rename, which is the old image while its imps go to sleep. Picked
# before the sleeps and again once the host restarts on the new image.
cli=impz
pick_cli() {
  cli=impz
  "$runtime" exec "$container" impz --version >/dev/null 2>&1 || cli=imp
}

impz() {
  "$runtime" exec "$container" "$cli" "$@"
}

list_awake() {
  local imps
  imps=$(impz ls --json) || return 1
  jq -r '.[] | select(.state == "running") | .name' <<<"$imps"
}

# the counts `impz info` reports; an older impd has none, and the NOTE column
# that follows still names each imp
print_boot_status() {
  local info
  if ! info=$(impz info --json); then
    echo "upgrade: impz info failed; see the NOTE column below" >&2
    return
  fi
  jq -r '
    if .bootStatus == null then
      "upgrade: this impd does not count cold boots; see the NOTE column below"
    else
      .bootStatus as $status
      | [$status.outdated | to_entries[] | select(.value > 0) | "\(.value) \(.key)"]
      | (if length == 0 then "none" else join(", ") end) as $outdated
      | "upgrade: \($status.coldBoots) imps will boot cold; outdated: \($outdated)"
    end' <<<"$info" || echo "upgrade: could not read impz info; see the NOTE column below" >&2
}

# the runtime that runs imp-host: podman, docker, or nothing when neither
# has the container
find_runtime() {
  if podman container exists "$container" 2>/dev/null; then
    echo podman
  elif command -v docker >/dev/null && docker container inspect "$container" >/dev/null 2>&1; then
    echo docker
  fi
}

# an image id without the sha256: that Docker puts before it and Podman
# does not
image_id() { echo "${1#sha256:}"; }

# The proxy's unit, out of the way on Podman, which gives no Docker: stopped,
# disabled, and kept as .bak-<time>, named in $proxy_backup
retire_proxy_unit() {
  [ -f "$proxy_unit_file" ] || return 0
  if ! systemctl disable -q --now imp-docker-proxy; then
    echo "upgrade: cannot stop imp-docker-proxy, whose unit stays for the next run; $(format_host_state)" >&2
    exit 1
  fi
  proxy_backup=$proxy_unit_file.bak-$(backup_time)
  mv "$proxy_unit_file" "$proxy_backup"
  systemctl daemon-reload
  echo "upgrade: stopped and disabled imp-docker-proxy, which this image does not call (the unit before: $proxy_backup)"
}

# fetch_file NAME PATH: the image's deploy/NAME into PATH.new. Fails, and
# leaves no PATH.new, when the image cannot give it or gives it empty. Its
# caller tests it, so set -e is off in here: each step is checked.
fetch_file() {
  if ! podman run --rm "$image" cat "$image_deploy/$1" | strip_markers >"$2.new" || [ ! -s "$2.new" ]; then
    rm -f "$2.new"
    echo "upgrade: cannot read $image_deploy/$1 from $image; nothing changed, the host still runs $old" >&2
    return 1
  fi
}

# install_file PATH: PATH.new into place, by rename, when it differs; fails
# when it is unchanged. A changed unit stays as .bak-<time>, named in
# $unit_backup, for a rollback.
install_file() {
  if cmp -s "$1.new" "$1"; then
    rm -f "$1.new"
    return 1
  fi
  local kept=
  if [ "$1" = "$unit_file" ] && [ -f "$1" ]; then
    unit_backup=$1.bak-$(backup_time)
    kept=" (the unit before: $unit_backup)"
    if ! cp -p "$1" "$unit_backup"; then
      unit_backup=
      echo "upgrade: cannot keep $1 as a .bak; $(format_host_state)" >&2
      exit 1
    fi
  fi
  # its caller tests it, so set -e is off in here: a failed rename stops
  # the upgrade before the restart
  if ! mv "$1.new" "$1"; then
    echo "upgrade: cannot install $1; $(format_host_state)" >&2
    exit 1
  fi
  echo "upgrade: installed $1 from $image$kept"
}

# The env file's migration, then the files fetched into $new_files, and a
# daemon-reload when the unit changed. The migration comes first: a failed
# rewrite stops here, with the old unit in place.
install_new_files() {
  local f unit_changed=
  migrate_env_file
  for f in "${new_files[@]}"; do
    if install_file "$f" && [ "$f" = "$unit_file" ]; then
      unit_changed=1
    fi
  done
  [ -z "$unit_changed" ] || systemctl daemon-reload
}

# A Docker host's imp-host, out of the way before the new unit is installed:
# stopped with the old unit's own ExecStop, which Docker's container needs,
# then its container, the proxy and, with IPv6, Docker's network, whose
# bridge and /64 Podman takes over
retire_docker_host() {
  systemctl stop "$container"
  stopped=1
  docker rm -f "$container" >/dev/null 2>&1 || true
  retire_proxy_unit
  if [ -n "$docker_network" ]; then
    if ! docker network rm "$HOST_NETWORK" >/dev/null; then
      echo "upgrade: cannot remove Docker's $HOST_NETWORK network, whose bridge Podman needs; $(format_host_state)" >&2
      exit 1
    fi
    network_removed=1
    echo "upgrade: removed Docker's $HOST_NETWORK network; Podman makes its own on the same /64"
  fi
}

# the rollback once the new host has started, from Podman to the old image
# or, after a move, to Docker
format_rollback() {
  if [ "$moved_from" = docker ]; then
    echo "To roll back to Docker: $(format_docker_rollback)."
  else
    echo "To roll back: podman tag $old $image, then systemctl restart $container."
  fi
}

# report_failure COMMAND: what the failed COMMAND leaves, before set -e
# exits: the rollback once the start or restart has run
restarting=
report_failure() {
  [ "$BASH_SUBSHELL" -eq 0 ] || return 0
  if [ -n "$restarting" ]; then
    echo "upgrade: $container did not start; see: journalctl -u $container. $(format_rollback)" >&2
  else
    echo "upgrade: $1 failed; $(format_host_state)" >&2
  fi
}

wait_ready() {
  local deadline=$((SECONDS + ready_timeout_s))
  until curl -fsS "$health" 2>/dev/null | grep -q '"ready":true'; do
    if [ $SECONDS -ge $deadline ]; then
      echo "upgrade: impd is not ready after $ready_timeout_s s; see: podman logs $container. $(format_rollback)" >&2
      exit 1
    fi
    sleep 1
  done
}

for tool in podman curl jq; do
  command -v "$tool" >/dev/null && continue
  if [ "$tool" = podman ]; then
    echo "upgrade: podman is not installed; install it (apt-get install podman catatonit netavark aardvark-dns iptables), or run this release's deploy/bootstrap.sh" >&2
  else
    echo "upgrade: $tool is not installed" >&2
  fi
  exit 1
done

runtime=$(find_runtime)
if [ -z "$runtime" ]; then
  echo "upgrade: no $container container; start the host first (docs/guides/install.md)" >&2
  exit 1
fi

if ! refusal=$(check_env_image "$env_file" 2>&1); then
  echo "upgrade: $refusal; nothing changed" >&2
  exit 1
fi

image=$(read_image)

echo "upgrade: pulling $image"
podman pull -q "$image" >/dev/null

# set -e misses a failed inspect nested in another substitution
old_ref=$("$runtime" inspect -f '{{.Image}}' "$container")
new_ref=$(podman image inspect -f '{{.Id}}' "$image")
old=$(image_id "$old_ref")
new=$(image_id "$new_ref")

[ "$old" = "$new" ] || echo "upgrade: $old -> $new"

contract=$(podman image inspect -f '{{index .Config.Labels "imp.host-contract"}}' "$image")
if [ "$contract" != no-docker ]; then
  echo "upgrade: $image needs a Docker socket (imp.host-contract ${contract:-unset}), which a Podman host does not give. Nothing changed." >&2
  echo "upgrade: to roll back to it, put back the imp-host.service.bak-<time> (and imp-docker-proxy.service.bak-<time>) units that the upgrade from it kept, or run deploy/bootstrap.sh of its release (docs/guides/operations.md#upgrade)." >&2
  exit 1
fi

# Docker's imp-host network, with IPv6: the names of the containers on it,
# empty when it holds none; unset when Docker has no such network
docker_network=
if [ "$runtime" = docker ] &&
  network_containers=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$HOST_NETWORK" 2>/dev/null); then
  docker_network=1
  others=$(tr ' ' '\n' <<<"$network_containers" | grep -vx -e "$container" -e '' | paste -sd ' ' - || true)
  if [ -n "$others" ]; then
    echo "upgrade: Docker's $HOST_NETWORK network also holds $others, and Podman needs its bridge: take them off it (docker network disconnect $HOST_NETWORK <name>) and run again. Nothing changed." >&2
    exit 1
  fi
fi

# The image's seccomp profile and unit, read before any imp sleeps: an
# image that cannot give them stops the upgrade with the host untouched.
new_files=("$seccomp_file" "$unit_file")
trap 'for f in "${new_files[@]}"; do rm -f "$f.new"; done' EXIT
fetch_file imp-host.seccomp.json "$seccomp_file" || exit 1
fetch_file imp-host.service "$unit_file" || exit 1

# An image from before the move to Podman has the no-docker label and a unit
# that runs Docker, which would put this host back on Docker.
if ! grep -q '^ExecStart=/usr/bin/podman run ' "$unit_file.new"; then
  echo "upgrade: the imp-host.service in $image does not run Podman, which this host runs imp-host with; to go back to it, put back the units that the upgrade from it kept, or run deploy/bootstrap.sh of its release (docs/guides/operations.md#upgrade). Nothing changed." >&2
  exit 1
fi

# The unit takes the image from the env file, else its own default: one
# from the environment alone would pull here, then restart into another.
unit_runs=$(unit_image "$unit_file.new" "$unit_file")
if [ -n "$unit_runs" ] && [ "$unit_runs" != "$image" ]; then
  echo "upgrade: $(basename "$unit_file") would run $unit_runs, not $image; pin IMP_HOST_IMAGE=$image in $env_file and run again. Nothing changed." >&2
  exit 1
fi

# A host on :latest may run this release's image already. It still gets
# its image lines and this image's unit, or the old unit's :latest would
# run another image at the next restart. The proxy still goes, or it keeps
# the host's Docker socket. Nothing restarts.
if [ "$runtime" = podman ] && [ "$old" = "$new" ]; then
  install_new_files
  retire_proxy_unit
  echo "upgrade: $container already runs $new"
  exit 0
fi

pick_cli
# its own line: a failed `impz ls` stops the script before anything restarts
awake=$(list_awake)

for name in $awake; do
  if ! impz sleep "$name" >/dev/null; then
    echo "upgrade: $name did not sleep; the host still runs $old" >&2
    exit 1
  fi
  echo "upgrade: $name asleep"
done

moved_from=$runtime
# set -e skips the ERR trap only where it skips the exit, so a failed step
# that prints nothing of its own still prints what it leaves.
set -E
trap 'report_failure "$BASH_COMMAND"' ERR
if [ "$runtime" = docker ]; then
  retire_docker_host
  install_new_files
  # A start that fails may have made Podman's network already.
  started=1
  restarting=1
  systemctl start "$container"
else
  install_new_files
  retire_proxy_unit
  restarting=1
  systemctl restart "$container"
fi
runtime=podman
wait_ready
trap - ERR
pick_cli

if [ "$moved_from" = docker ]; then
  echo "upgrade: done, on Podman. $(format_rollback)"
  echo "upgrade: imp no longer needs Docker; docs/guides/operations.md#upgrade says how to remove it."
else
  echo "upgrade: done. $(format_rollback)"
fi
print_boot_status
impz ls
