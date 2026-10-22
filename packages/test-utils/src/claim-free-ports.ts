import { onTestFinished } from 'bun:test';
import { randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

const PICK_SPAN = 4000;

interface FindFreePortsOptions {
  readonly pick?: () => number;
  readonly onRelease?: (release: () => void) => void;
}

// A process that binds one of these ports without taking a claim can still race for it.
export function claimFreePorts(count: number, options: FindFreePortsOptions = {}) {
  const top = readEphemeralStart();
  const pick = options.pick ?? (() => randomInt(top - PICK_SPAN, top));
  const claims: NonNullable<ReturnType<typeof claimPort>>[] = [];
  const ports: number[] = [];
  const onRelease = options.onRelease ?? onTestFinished;

  onRelease(() => {
    for (const claim of claims) {
      claim.stop(true);
    }
  });

  while (ports.length < count) {
    const port = pick();
    const claim = claimPort(port);

    if (claim === null) {
      continue;
    }

    claims.push(claim);

    if (!readBusyPorts().has(port)) {
      ports.push(port);
    }
  }

  return {
    take: (): number => {
      const port = ports.shift();

      if (port === undefined) {
        throw new Error(`only ${String(count)} free ports were asked for`);
      }

      return port;
    },
  };
}

// The kernel gives a bind to port 0 or an outgoing connection a port from this start up,
// so a port below it is taken only by an explicit bind.
function readEphemeralStart(): number {
  const range = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8');

  return Number(range.trim().split(/\s+/u)[0]);
}

// Only one process on the host can bind an abstract unix socket, and the kernel frees it
// when that process dies, so the claim holds across test processes and never leaks.
function claimPort(port: number) {
  try {
    return Bun.listen({ unix: `\0imp-test-port-${String(port)}`, socket: { data: () => {} } });
  } catch {
    return null;
  }
}

const SOCKET_TABLES = ['tcp', 'tcp6', 'udp', 'udp6'].map((name) => `/proc/net/${name}`);

function readBusyPorts(): ReadonlySet<number> {
  const busy = new Set<number>();

  // a kernel without IPv6 has no tcp6 or udp6 table
  for (const table of SOCKET_TABLES.filter((path) => existsSync(path))) {
    // the header line, then one socket per line: `sl local_address ...`,
    // where local_address is `<hex address>:<hex port>`
    const lines = readFileSync(table, 'utf8').trim().split('\n');

    for (const line of lines.slice(1)) {
      const local = line.trim().split(/\s+/u)[1] ?? '';
      const hexPort = local.slice(local.lastIndexOf(':') + 1);

      busy.add(Number.parseInt(hexPort, 16));
    }
  }

  return busy;
}
