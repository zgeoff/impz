import { buildUnshare } from './build-unshare';

export function probeUnshare(command: readonly string[]): boolean {
  if (process.env['IMP_HOST_TESTS'] === 'required') {
    return true;
  }

  const unshare = buildUnshare({ mount: false, uid: process.getuid?.() });
  const probe = Bun.spawnSync([...unshare, ...command], { stdout: 'ignore', stderr: 'pipe' });

  if (probe.exitCode === 0) {
    return true;
  }

  // Bun's report counts skipped tests but names none, so a host that lacks a
  // feature would otherwise pass in silence.
  process.stderr.write(
    `probe-unshare: its tests skip, as this fails in a network namespace (IMP_HOST_TESTS=required fails them instead): ${JSON.stringify(command)}\n${probe.stderr.toString()}`,
  );

  return false;
}
