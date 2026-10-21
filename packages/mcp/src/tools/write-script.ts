// Each command works in both coreutils and BusyBox.
export const WRITE_SCRIPT = [
  'set -e',

  // An exit before the content is read still drains stdin, because the writer
  // would meet a closed pipe whose EPIPE hides this exit and its message.
  "trap 'cat >/dev/null' EXIT",
  'target=$1',
  'if [ -L "$target" ]; then',
  '  target=$(readlink -f "$target") || { echo "cannot resolve the symlink $1" >&2; exit 1; }',
  'fi',
  'if [ -d "$target" ]; then echo "$1 is a directory" >&2; exit 1; fi',
  'dir=$(dirname "$target")',
  'mkdir -p "$dir"',
  'tmp=$(mktemp "$dir/.imp-write.XXXXXX")',
  'trap \'rm -f "$tmp"; cat >/dev/null\' EXIT',
  'cat > "$tmp"',
  'if [ -e "$target" ]; then mode=$(stat -c %a "$target"); else mode=$(printf %o $((0666 & ~$(umask)))); fi',
  'chmod "$mode" "$tmp"',
  'mv -f "$tmp" "$target"',
  'trap - EXIT',
].join('\n');
