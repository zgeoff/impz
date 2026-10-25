interface StubBootstrapDocker {
  // An imp-host container that an older release runs under Docker.
  readonly hostContainer?: 'present';

  // The test harness's teardown script inside a test container, and the container's removal.
  readonly teardown?: 'fails';
  readonly removal?: 'fails';
}

export function buildStubBootstrapDocker(stub: StubBootstrapDocker): string {
  const hostContainer =
    stub.hostContainer === 'present'
      ? `echo '[{"Name": "/imp-host"}]'`
      : 'echo "Error response from daemon: No such container: imp-host" >&2; exit 1';

  return `case "$*" in
  "container inspect imp-host") ${hostContainer} ;;
  "exec "*" bash -c "*) ${stub.teardown === 'fails' ? 'echo "teardown: zpool destroy failed: pool is busy" >&2; exit 1' : ':'} ;;
  "rm -f -v "*) ${stub.removal === 'fails' ? 'echo "Error response from daemon: cannot remove container" >&2; exit 1' : ':'} ;;
  *)echo "unexpected: docker $*" >&2; exit 1 ;;
esac`;
}
