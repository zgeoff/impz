import { join } from 'node:path';
import { loadOrCreateBrokerCa } from '../../src/network/broker/tls/broker-ca';

interface StubTlsUpstreamOptions {
  readonly directory: string;
  readonly host?: string;
  readonly respond: (request: Request) => Response | Promise<Response>;
}

// Real TLS with a CA of its own, because MSW interception cannot carry
// certificate verification.
export async function startStubBrokerTlsUpstream(
  stack: Readonly<AsyncDisposableStack>,
  options: Readonly<StubTlsUpstreamOptions>,
) {
  const ca = await loadOrCreateBrokerCa(join(options.directory, 'stub-upstream-ca'));
  const leaf = await ca.issueLeaf(options.host ?? 'localhost');

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: leaf.certPem, key: leaf.keyPem },
    fetch: options.respond,
  });

  stack.defer(() => server.stop(true));

  const port = server.port ?? 0;

  return { port, origin: `https://localhost:${String(port)}`, caPem: ca.certPem };
}
