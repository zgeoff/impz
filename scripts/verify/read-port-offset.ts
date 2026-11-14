import { collectDevPorts } from './collect-dev-ports.ts';

// Offsets 100 apart, so no two of them share a port: the API of one is never the MCP route of the
// next. A developer's own instances sit at small offsets, so the search starts at 500.
const OFFSETS = Array.from({ length: 40 }, (_, index) => 500 + index * 100);

// The first port offset whose ports are all free on this machine, for a dev instance of the run's
// own.
export function readPortOffset(): number {
  const offset = OFFSETS.find((candidate) =>
    collectDevPorts(candidate).every((port) => probePortFree(port)),
  );

  if (offset === undefined) {
    throw new Error(`no dev instance port offset from 500 to 4400 has every port free`);
  }

  return offset;
}

function probePortFree(port: number): boolean {
  try {
    const listener = Bun.listen({ hostname: '0.0.0.0', port, socket: { data: () => {} } });

    listener.stop(true);

    return true;
  } catch {
    return false;
  }
}
