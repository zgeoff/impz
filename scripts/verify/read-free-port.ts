import { randomInt } from 'node:crypto';

// impd refuses a public MCP port among the imps' slot ports, 20000 to 36383, and the kernel's
// ephemeral range starts at 32768, so a port from a bind to port 0 can land in the slot range.
const LOWEST_PORT = 10_000;
const HIGHEST_PORT = 19_999;

// A loopback port below the imps' slot ports that nothing listens on now, for a listener that impd
// opens itself.
export function readFreePort(): number {
  for (;;) {
    const port = randomInt(LOWEST_PORT, HIGHEST_PORT + 1);

    if (probeListen(port)) {
      return port;
    }
  }
}

function probeListen(port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });

    listener.stop(true);

    return true;
  } catch {
    return false;
  }
}
