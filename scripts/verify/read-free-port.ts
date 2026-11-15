import { randomInt } from 'node:crypto';
import { WringerError } from '@wringer/core';

// impd refuses a public MCP port among the imps' slot ports, 20000 to 36383, and the kernel's
// ephemeral range starts at 32768, so a port from a bind to port 0 can land in the slot range.
const LOWEST_PORT = 10_000;
const HIGHEST_PORT = 19_999;
const MOST_ATTEMPTS = 100;

type BindPort = (port: number) => void;

// A loopback port below the imps' slot ports that nothing listens on now, for a listener that impd
// opens itself. Only a taken port earns another try, so a machine that refuses binds fails the
// launch.
export function readFreePort(bind: BindPort = bindLoopback): number {
  for (let attempt = 0; attempt < MOST_ATTEMPTS; attempt++) {
    const port = randomInt(LOWEST_PORT, HIGHEST_PORT + 1);

    try {
      bind(port);

      return port;
    } catch (error) {
      if (!isAddressInUse(error)) {
        throw new WringerError('environment', {
          message: `no loopback port can be bound: ${String(error)}`,
        });
      }
    }
  }

  throw new WringerError('environment', {
    message: `no free loopback port from ${LOWEST_PORT} to ${HIGHEST_PORT} after ${MOST_ATTEMPTS} tries`,
  });
}

function bindLoopback(port: number): void {
  const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });

  listener.stop(true);
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
}
