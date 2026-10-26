import type { BootstrapIO } from './types';

export const STUB_IMAGE = 'imp-host-stub:test';
export const STALE_STUB_IMAGE = 'imp-host-stub:stale';

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

export async function createStubImages(io: BootstrapIO): Promise<void> {
  await io.shell`docker build -q -t ${STUB_IMAGE} - < ${new Response(STUB_DOCKERFILE)}`.quiet();

  const stale = `FROM ${STUB_IMAGE}\nLABEL imp.host-contract="unprivileged"\n`;

  await io.shell`docker build -q -t ${STALE_STUB_IMAGE} - < ${new Response(stale)}`.quiet();
}
