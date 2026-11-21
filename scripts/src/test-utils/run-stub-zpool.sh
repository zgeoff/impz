# shellcheck shell=bash
# The body of the zpool that createStubZpool writes, which sources this file
# after it logs the call to $STUB_CALLS. It keeps its pools as `<name> <vdev>`
# lines in the stubs directory's pools file, so list, status -P and destroy see
# what create made. The settings files beside that file, each one line:
# - zpool.create: `fails`, `held` or empty; a held create writes the path in
#   zpool.create-started, then waits for the path in zpool.create-release
#   before the pool exists, and fails without a pool after 30 s
# - zpool.destroy: `fails`, `busy` (it fails as zpool does for a held pool),
#   `ignored` (it exits 0 and the pool stays), `held` (it waits as a held create
#   does, on zpool.destroy-started and zpool.destroy-release, then destroys the
#   pool) or empty
# - zpool.queries: `fail` makes list -H and status fail once a pool exists
stubs=${STUB_CALLS%/*}
pools=$stubs/pools
touch "$pools"

read -r create < "$stubs/zpool.create" || create=
read -r destroy < "$stubs/zpool.destroy" || destroy=
read -r queries < "$stubs/zpool.queries" || queries=

# a query once a pool exists fails, when the settings say so
check_query() {
  if [ "$queries" = fail ] && [ -s "$pools" ]; then
    exit 1
  fi
}

# writes the path in the stubs file $1-started, then waits for the path in
# $1-release, and fails after 30 s
hold() {
  local started release held=0
  read -r started < "$stubs/$1-started"
  read -r release < "$stubs/$1-release"
  : > "$started"
  while [ ! -e "$release" ]; do
    [ "$held" -lt 600 ] || {
      echo "no release within 30 s" >&2
      exit 1
    }
    held=$((held + 1))
    sleep 0.05
  done
}

# the last two arguments: a create's pool and vdev, a destroy's pool
for arg; do
  prev=$last
  last=$arg
done

case "$1" in
  list)
    if [ "$2" = -H ]; then
      check_query
      while read -r pool _; do printf '%s\n' "$pool"; done < "$pools"
    else
      grep -q "^$2 " "$pools"
    fi
    ;;
  create)
    if [ "$create" = fails ]; then
      echo "pool already exists" >&2
      exit 1
    elif [ "$create" = held ]; then
      hold zpool.create
    fi
    printf '%s %s\n' "$prev" "$last" >> "$pools"
    ;;
  status)
    check_query
    want=$3
    if [ -n "$want" ] && ! grep -q "^$want " "$pools"; then
      echo "cannot open '$want': no such pool" >&2
      exit 1
    fi
    while read -r pool file; do
      if [ -z "$want" ] || [ "$pool" = "$want" ]; then
        printf '  pool: %s\n\t  %s  ONLINE  0 0 0\n' "$pool" "$file"
      fi
    done < "$pools"
    ;;
  destroy)
    if [ "$destroy" = fails ]; then
      exit 1
    elif [ "$destroy" = busy ]; then
      echo "cannot destroy '$last': pool is busy" >&2
      exit 1
    elif [ "$destroy" = ignored ]; then
      exit 0
    elif [ "$destroy" = held ]; then
      hold zpool.destroy
    fi
    grep -v "^$last " "$pools" > "$pools.next" || true
    mv "$pools.next" "$pools"
    ;;
esac
