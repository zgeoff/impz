import type { BootstrapIO } from './types';

export const STUB_IMAGE = 'imp-host-stub:test';
export const STALE_STUB_IMAGE = 'imp-host-stub:stale';

// Stands in for the release image: the unit runs it with the same flags, so every phase but the
// health check runs as on a server. Its tailscale reports Running and it saves node state, so the
// bootstrap's tailscale phase (wait, then blank the key) runs too.
const STUB_DOCKERFILE = `FROM debian:trixie-slim
LABEL imp.tailscale-keyless="1"
LABEL imp.host-contract="socket-proxy"
# stands in for imp-docker-proxy: a socket where the proxy's would be
COPY --chmod=755 <<'SH' /usr/local/bin/imp-docker-proxy
#!/bin/sh
exec perl -MIO::Socket::UNIX -MSocket -e 'IO::Socket::UNIX->new(Type => SOCK_STREAM, Local => "/run/imp-docker/docker.sock", Listen => 1) or die "listen: $!"; sleep'
SH
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

// The stale image is the release before the proxy, as a stale :latest on an older host would be.
export async function createStubImages(io: BootstrapIO): Promise<void> {
  await io.shell`docker build -q -t ${STUB_IMAGE} - < ${new Response(STUB_DOCKERFILE)}`.quiet();

  const stale = `FROM ${STUB_IMAGE}\nLABEL imp.host-contract="unprivileged"\n`;

  await io.shell`docker build -q -t ${STALE_STUB_IMAGE} - < ${new Response(stale)}`.quiet();
}
