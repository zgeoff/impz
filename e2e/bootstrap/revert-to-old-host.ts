import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';
import { waitForImpHost } from './wait-for-imp-host';

export async function revertToOldHost(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  await applyBootstrap(run, target, {
    extra: ['--ipv6', 'off'],
    failure: 'the --ipv6 off run before an older host failed',
  });

  await runInContainer(run, [
    'sed',
    '-i',
    String.raw`/^IMP_HOST_\(IPV6\|SUBNET6\|NETWORK\)=/d`,
    '/etc/imp/imp-host.env',
  ]);

  await runInContainer(run, [
    'sed',
    '-i',
    '/IMP_HOST_NETWORK/d',
    '/etc/systemd/system/imp-host.service',
  ]);

  await runInContainer(run, ['systemctl', 'daemon-reload']);

  // As bootstrap.sh's unit reload does: the runs before this one restarted imp-host often enough
  // to near systemd's start-rate limit.
  await runInContainer(run, ['systemctl', 'reset-failed', 'imp-host']);

  const restart = await readInContainer(run, ['systemctl', 'restart', 'imp-host']);

  if (restart.exitCode !== 0) {
    const journal = await readInContainer(run, [
      'journalctl',
      '-u',
      'imp-host',
      '--no-pager',
      '-n',
      '20',
    ]);

    run.io.writeStderr(`${journal.output}\n`);
    throw new BootstrapTestError(`[${distro}] imp-host did not restart as an older host`);
  }

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running as an older host`);
  }
}
