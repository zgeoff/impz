# shellcheck shell=bash
# The packages phase: the tools, Podman, and the ZFS packages.

ensure_packages() {
  phase packages
  # apt_install skips Recommends, so the list names what Podman needs past its
  # dependencies: catatonit for --init, netavark and aardvark-dns, and iptables,
  # netavark's firewall driver. A Docker already on the host stays, untouched.
  local wanted=(ca-certificates curl xfsprogs nftables jq iproute2 util-linux
    podman catatonit netavark aardvark-dns iptables)
  local pkg missing=()
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "$APT_LOG" "${missing[@]}"
  fi
  [ "$storage" != zfs ] || ensure_zfs_packages
}

# Ubuntu ships the zfs module with its kernel; Debian builds it with DKMS,
# from contrib.
ensure_zfs_packages() {
  # shellcheck source=/dev/null
  . /etc/os-release
  local wanted=(zfsutils-linux) pkg missing=()
  if [ "$ID" = debian ]; then
    put_file /etc/apt/sources.list.d/imp-contrib.sources 644 "$(debian_contrib_sources)" || true
    wanted=("linux-headers-$(uname -r)" zfs-dkms zfsutils-linux)
  fi
  for pkg in "${wanted[@]}"; do
    dpkg-query -W -f '${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed' || missing+=("$pkg")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    change "apt-get install ${missing[*]}" apt_install "$APT_LOG" "${missing[@]}"
  fi
}

debian_contrib_sources() {
  cat <<'EOF'
# Written by deploy/bootstrap.sh: contrib, for zfs-dkms and zfsutils-linux.
Types: deb
URIs: http://deb.debian.org/debian
Suites: trixie trixie-updates
Components: contrib
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
EOF
}

# apt_install LOG PKG...: apt's output goes to LOG, shown only on failure.
apt_install() {
  local apt_log=$1
  shift
  if ! {
    apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$@"
  } >"$apt_log" 2>&1; then
    tail -n 20 "$apt_log" >&2
    die "apt-get install $* failed; the whole log is in $apt_log"
  fi
}

# ensure_service UNIT: enabled and active.
ensure_service() {
  systemctl -q is-enabled "$1" 2>/dev/null || change "enable $1" systemctl enable -q "$1"
  systemctl -q is-active "$1" 2>/dev/null || change "start $1" systemctl start "$1"
}
