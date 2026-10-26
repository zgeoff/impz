import { runImp } from './imp-cli';
import { runInContainer } from './instance';
import { waitFor } from './wait-for';

export const LAN = {
  netns: 'e2e-egress-lan',
  private: '10.250.77.1',
  linkLocal: '169.254.77.1',
  port: 8077,
  log: '/tmp/e2e-egress-lan.log',
} as const;

export function countLanConnections(
  log: string,
  addresses: readonly string[],
): Readonly<Record<string, number>> {
  const locals = log.split('\n').map((line) => line.split(' ')[0] ?? '');

  return Object.fromEntries(
    addresses.map((address) => [address, locals.filter((local) => local === address).length]),
  );
}

export interface Dial {
  readonly isConnected: boolean;
  readonly durationMs: number;
  readonly error: string;
}

export function parseTimedDial(out: string): Dial {
  const [rc = '', durationMs = '', ...words] = out.trim().split(' ');

  return { isConnected: rc === '0', durationMs: Number(durationMs), error: words.join(' ') };
}

const LAN_LISTENER = `
const { appendFileSync } = require('node:fs');
Bun.listen({
  hostname: '0.0.0.0',
  port: ${String(LAN.port)},
  socket: {
    open: (socket) => {
      appendFileSync('${LAN.log}', socket.localAddress + ' ' + socket.remoteAddress + '\\n');
      socket.write('hello\\n');
    },
    data: () => {},
  },
});
`;

const LAN_SETUP = `
set -e
ip netns del ${LAN.netns} 2>/dev/null || true
ip link del e2elan0 2>/dev/null || true
ip netns add ${LAN.netns}
ip link add e2elan0 type veth peer name eth0 netns ${LAN.netns}
ip addr add 10.250.77.254/24 dev e2elan0
ip link set e2elan0 up
ip -n ${LAN.netns} addr add ${LAN.private}/24 dev eth0
ip -n ${LAN.netns} addr add ${LAN.linkLocal}/32 dev eth0
ip -n ${LAN.netns} link set eth0 up
ip -n ${LAN.netns} link set lo up
ip -n ${LAN.netns} route add default via 10.250.77.254
ip route add ${LAN.linkLocal}/32 dev e2elan0
: > ${LAN.log}
setsid ip netns exec ${LAN.netns} bun -e "$LISTENER" </dev/null >/dev/null 2>&1 &
`;

export async function startLanNetns(): Promise<void> {
  const result = await runInContainer(['env', `LISTENER=${LAN_LISTENER}`, 'sh', '-c', LAN_SETUP]);

  if (result.exitCode !== 0) {
    throw new Error(`the lan netns: ${result.stderr}`);
  }

  await waitFor('the lan listeners', async () => {
    const probes = await Promise.all(
      [LAN.private, LAN.linkLocal].map((address) =>
        runInContainer(['bash', '-c', `exec 3<>/dev/tcp/${address}/${String(LAN.port)}`]),
      ),
    );

    if (probes.some((probe) => probe.exitCode !== 0)) {
      throw new Error('a lan listener is not up yet');
    }
  });
}

export async function stopLanNetns(): Promise<void> {
  await runInContainer([
    'sh',
    '-c',
    `ip netns pids ${LAN.netns} | xargs -r kill; ip netns del ${LAN.netns}; rm -f ${LAN.log}`,
  ]);
}

export async function readLanConnections(): Promise<Readonly<Record<string, number>>> {
  const result = await runInContainer(['cat', LAN.log]);

  return countLanConnections(result.stdout, [LAN.private, LAN.linkLocal]);
}

export async function runTimedDial(name: string, target: string, port: number): Promise<Dial> {
  // nc fails in silence, so wget retries a failure to name it. A refusal
  // resets at once, where a drop takes all 5 s of -w.
  const script = [
    'rm -f /tmp/dial-err',
    "s=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `echo | nc -w 5 ${target} ${String(port)} >/dev/null 2>&1`,
    'rc=$?',
    "e=$(cut -d ' ' -f 1 /proc/uptime | tr -d .)",
    `[ $rc = 0 ] || wget -q -T 5 -O /dev/null http://${target}:${String(port)}/ 2>/tmp/dial-err`,
    String.raw`echo "$rc $(( (e - s) * 10 )) $(head -c 200 /tmp/dial-err | tr -s "\n" " ")"`,
  ].join('; ');

  const out = await runImp('exec', name, '--', 'sh', '-c', script);

  return parseTimedDial(out);
}
