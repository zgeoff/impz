import { buildUnshare } from './build-unshare';

export function probeUnshare(command: readonly string[]): boolean {
  if (process.env['IMP_HOST_TESTS'] === 'required') {
    return true;
  }

  const unshare = buildUnshare({ mount: false, uid: process.getuid?.() });
  const probe = Bun.spawnSync([...unshare, ...command], { stdout: 'ignore', stderr: 'ignore' });

  return probe.exitCode === 0;
}
