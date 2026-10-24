#!/bin/bash
# Make an imp disk from an image as impd's image writer does: export the
# image's tree, write /etc/imp/image.json, size the ext4 by rootfs-plan.ts's
# rule, mkfs.ext4 -d, then grow the file to impd's default 32 GiB disk and
# the filesystem with it, offline, as impd's create does.
#
#   make-disk.sh IMAGE TOOLS_IMAGE OUT
#
# TOOLS_IMAGE is any image with mkfs.ext4 and resize2fs, such as imp-host. The
# host needs docker and jq.
set -euo pipefail

image=$1
tools=$2
out=$(realpath "$3")

config=$(docker image inspect --format '{{json .Config}}' "$image" |
  jq -c '{env: (.Env // []), workdir: (.WorkingDir // ""), user: (.User // "")}')
container=$(docker create "$image" /bin/true)
trap 'docker rm -f "$container" >/dev/null' EXIT

docker export "$container" | docker run --rm -i \
  -v "$(dirname "$out"):/out" -e CONFIG="$config" -e NAME="$(basename "$out")" "$tools" \
  sh -euc '
    mkdir /tree
    tar -x -C /tree
    mkdir -p /tree/etc/imp
    printf "%s" "$CONFIG" > /tree/etc/imp/image.json
    bytes=$(du -sb /tree | cut -f1)
    inodes=$(find /tree | wc -l)
    gib=$((1024 * 1024 * 1024))
    size=$(( (bytes * 12 / 10 + 2 * gib + gib - 1) / gib * gib ))
    [ "$size" -ge $((4 * gib)) ] || size=$((4 * gib))
    inode_args=""
    [ $((inodes * 2)) -le $((size / 16384)) ] || inode_args="-N $((inodes * 2))"
    rm -f "/out/$NAME"
    truncate -s "$size" "/out/$NAME"
    mkfs.ext4 -q -F -L imp-root $inode_args -d /tree "/out/$NAME"
    truncate -s 32G "/out/$NAME"
    resize2fs -f "/out/$NAME" >/dev/null 2>&1
    chown "$(stat -c %u:%g /out)" "/out/$NAME"
  '
