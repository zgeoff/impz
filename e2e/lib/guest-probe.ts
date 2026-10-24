import { buildReachScript } from './build-reach-script';
import { tryImp } from './imp-cli';

export async function tryInImp(name: string, script: string): Promise<boolean> {
  const result = await tryImp(['exec', name, '--', 'sh', '-c', script]);

  return result.exitCode === 0;
}

export function tryGetFromImp(name: string, url: string): Promise<boolean> {
  return tryInImp(name, buildReachScript(url, 5));
}

export function tryDialFromImp(
  name: string,
  target: string,
  port: number,
  source = '',
): Promise<boolean> {
  const from = source === '' ? '' : `-s ${source}`;

  return tryInImp(name, `echo | nc -w 3 ${from} ${target} ${String(port)} >/dev/null`);
}
