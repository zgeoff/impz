// An HTTP answer of any status proves egress, since a refusal is a reset or ICMP, and example.com
// has answered 503. GNU wget exits 8 on an error status; BusyBox exits 1 and prints the status line.
export function buildReachScript(url: string, timeoutSeconds: number): string {
  return [
    `out=$(wget -q -T ${String(timeoutSeconds)} -O /dev/null ${url} 2>&1); rc=$?; case "$rc:$out" in`,
    "0:* | 8:* | *'server returned error: HTTP/'*) true ;;",
    `*) printf '%s\\n' "$out" >&2; false ;;`,
    'esac',
  ].join(' ');
}
