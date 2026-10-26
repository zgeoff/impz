import { BootstrapTestError } from './bootstrap-test-error';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

export async function checkImpEgress6(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  // 2001:db8::/32 is not among impd's blocked ranges.
  const address = '2001:db8:ffff::1';
  const name = 'egress6';

  run.log(`[${target.distro}] an imp reaches ${address} over IPv6`);

  await runInContainer(run, ['ip', 'link', 'add', 'imptarget', 'type', 'dummy']);
  await runInContainer(run, ['ip', 'link', 'set', 'imptarget', 'up']);

  await runInContainer(run, [
    'ip',
    '-6',
    'addr',
    'add',
    `${address}/128`,
    'dev',
    'imptarget',
    'nodad',
  ]);

  await readInContainer(run, ['podman', 'exec', 'imp-host', 'impz', 'rm', name]);

  await runInContainer(run, [
    'podman',
    'exec',
    'imp-host',
    'impz',
    'new',
    name,
    '--image',
    'ubuntu',
    '--memory',
    '512m',
  ]);

  const reach = await readInContainer(run, [
    'podman',
    'exec',
    'imp-host',
    'impz',
    'exec',
    name,
    '--',
    'timeout',
    '10',
    'bash',
    '-c',
    `exec 3<>/dev/tcp/${address}/22`,
  ]);

  if (reach.exitCode !== 0) {
    throw new BootstrapTestError(`[${target.distro}] the imp cannot reach ${address}:22 over IPv6`);
  }

  await runInContainer(run, ['podman', 'exec', 'imp-host', 'impz', 'rm', name]);
  await runInContainer(run, ['ip', 'link', 'del', 'imptarget']);
}
