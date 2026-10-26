import { runInContainer } from './instance';

export interface BalloonStats {
  readonly totalMib: number;
  readonly availableMib: number;
}

export function parseBalloonStats(text: string): BalloonStats {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`no balloon statistics in ${text}`);
  }

  return {
    totalMib: getMib(parsed, 'total_memory', text),
    availableMib: getMib(parsed, 'available_memory', text),
  };
}

function getMib(parsed: object, key: string, text: string): number {
  const bytes: unknown = Reflect.get(parsed, key);

  if (typeof bytes !== 'number') {
    throw new TypeError(`no ${key} in ${text}`);
  }

  return Math.floor(bytes / 1_048_576);
}

export async function readBalloonStats(impID: string): Promise<BalloonStats> {
  const socket = `/var/lib/imp/imps/${impID}/run/api.sock`;

  const result = await runInContainer([
    'curl',
    '--silent',
    '--fail',
    '--unix-socket',
    socket,
    'http://localhost/balloon/statistics',
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`GET /balloon/statistics on ${socket} exited ${String(result.exitCode)}`);
  }

  return parseBalloonStats(result.stdout);
}
