import { join } from 'node:path';
import type { BootstrapIO } from './types';

// Fully qualified, as podman load names them, so the test container's Podman resolves no short
// name.
export const STUB_IMAGE = 'localhost/imp-host-stub:test';
export const STALE_STUB_IMAGE = 'localhost/imp-host-stub:stale';

// upgrade.sh pulls the image it moves to, so the Docker host move runs a registry in the test
// container. Docker pushes over plain HTTP to a loopback address.
export const MOVE_REGISTRY = '127.0.0.1:5000';
export const MOVE_STUB_IMAGE = `${MOVE_REGISTRY}/imp-host-stub:move`;

// Its tailscale reports Running and it saves node state, so bootstrap.sh's tailscale phase (wait,
// then blank the key) runs as on a server.
const STUB_DOCKERFILE = `FROM debian:trixie-slim
LABEL imp.tailscale-keyless="1"
LABEL imp.host-contract="no-docker"
COPY --chmod=755 <<'SH' /usr/local/bin/tailscale
#!/bin/sh
echo '{"BackendState":"Running"}'
SH
COPY <<'SH' /usr/local/lib/imp/tailscale-up.sh
# stand-in: starts tailscaled from the saved node state
SH
COPY <<'JSON' /usr/local/share/imp/deploy/imp-host.seccomp.json
{"defaultAction": "SCMP_ACT_ALLOW"}
JSON
CMD ["sh", "-c", "mkdir -p /var/lib/imp/tailscale && echo stub >/var/lib/imp/tailscale/tailscaled.state && exec sleep infinity"]
`;

// upgrade.sh reads the unit from the image it moves to, lists the imps through the CLI, and waits
// for impd's health to say ready.
const MOVE_STUB_DOCKERFILE = String.raw`FROM ${STUB_IMAGE}
COPY imp-host.service /usr/local/share/imp/deploy/imp-host.service
COPY --chmod=755 <<'SH' /usr/local/bin/impz
#!/bin/sh
[ "$*" != "ls --json" ] || echo '[]'
SH
COPY <<'PL' /usr/local/lib/imp/serve-health.pl
use IO::Socket::INET;
my $server = IO::Socket::INET->new(LocalPort => 7070, Listen => 5, ReuseAddr => 1) or die "listen: $!";
while (my $client = $server->accept) {
  while (my $line = <$client>) { last if $line =~ /^\r?$/; }
  print $client "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ready\":true}\n";
  close $client;
}
PL
CMD ["perl", "/usr/local/lib/imp/serve-health.pl"]
`;

export async function createStubImages(io: BootstrapIO, root: string): Promise<void> {
  await io.shell`docker build -q -t ${STUB_IMAGE} - < ${new Response(STUB_DOCKERFILE)}`.quiet();

  const stale = `FROM ${STUB_IMAGE}\nLABEL imp.host-contract="unprivileged"\n`;

  await io.shell`docker build -q -t ${STALE_STUB_IMAGE} - < ${new Response(stale)}`.quiet();
  await io.shell`docker build -q -t ${MOVE_STUB_IMAGE} -f - ${join(root, 'deploy')} < ${new Response(MOVE_STUB_DOCKERFILE)}`.quiet();
}
