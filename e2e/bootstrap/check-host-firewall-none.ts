import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { expectInContainer } from './expect-in-container';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';
import { waitForImpHost } from './wait-for-imp-host';

const NONE = ['--host-firewall', 'none'];

export async function checkHostFirewallNone(
  run: BootstrapRun,
  target: BootstrapTarget,
): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] --host-firewall none`);

  const plan = await expectBootstrapExit(run, target, { want: 2, mode: '--check', extra: NONE });

  if (!plan.includes('would: remove imp-firewall.service and the inet imp_host table')) {
    throw new BootstrapTestError(`[${distro}] --check did not plan the firewall's removal`);
  }

  await applyBootstrap(run, target, {
    extra: NONE,
    failure: 'the run with --host-firewall none failed',
  });

  await expectInContainer(run, {
    argv: ['test', '!', '-e', '/etc/systemd/system/imp-firewall.service'],
    failure: `[${distro}] imp-firewall.service is left`,
  });

  await expectInContainer(run, {
    argv: ['test', '!', '-e', '/etc/imp/firewall.nft'],
    failure: `[${distro}] /etc/imp/firewall.nft is left`,
  });

  await expectInContainer(run, {
    argv: ['nft', 'list', 'table', 'inet', 'imp_host'],
    failure: `[${distro}] the inet imp_host table is left`,
    fails: true,
  });

  const ruleset = await readInContainer(run, ['nft', 'list', 'ruleset']);

  if (/hook input .*policy drop/u.test(ruleset.output)) {
    throw new BootstrapTestError(`[${distro}] an input chain with policy drop is left`);
  }

  await expectInContainer(run, {
    argv: ['grep', '-qx', 'IMP_HOST_FIREWALL=none', '/etc/imp/imp-host.env'],
    failure: `[${distro}] the env file does not say none`,
  });

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running with --host-firewall none`);
  }

  run.log(`[${distro}] --host-firewall none again changes nothing`);

  const again = await applyBootstrap(run, target, {
    extra: NONE,
    failure: 'the second run with --host-firewall none failed',
  });

  if (!again.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] --host-firewall none is not idempotent`);
  }

  run.log(`[${distro}] the env file keeps none`);

  await expectBootstrapExit(run, target, { want: 0, mode: '--check' });

  run.log(`[${distro}] a table that comes back is drift, and --yes refuses it`);

  await runInContainer(run, ['nft', 'add', 'table', 'inet', 'imp_host']);
  await expectBootstrapExit(run, target, { want: 2, mode: '--check' });

  const refusal = await expectBootstrapExit(run, target, { want: 1, mode: '--yes' });

  if (!refusal.includes('run with --host-firewall none to remove it')) {
    throw new BootstrapTestError(`[${distro}] no hint for the drift`);
  }

  await runInContainer(run, ['nft', 'delete', 'table', 'inet', 'imp_host']);
}
