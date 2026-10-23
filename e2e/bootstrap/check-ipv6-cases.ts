import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { checkIPv6On } from './check-ipv6-on';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { expectInContainer } from './expect-in-container';
import { readEnvValue } from './read-env-value';
import { readImpHostNetworks } from './read-imp-host-networks';
import { readInContainer } from './read-in-container';
import { revertToOldHost } from './revert-to-old-host';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';
import { waitForImpHost } from './wait-for-imp-host';

// A dotted uplink name, whose sysctl path takes a slash form.
const FAKE_UPLINK = 'eth9.7';

// A network that differs is recreated; accept_ra=2 goes on a dotted uplink whose default route the
// kernel took from router adverts; --ipv6 off undoes both; a client that takes router adverts stops
// the run that would turn IPv6 on, unless --ra-handled.
export async function checkIPv6Cases(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const subnet = await readEnvValue(run, 'IMP_HOST_SUBNET6');

  await checkNetworkRecreated(run, target, subnet);
  await checkAcceptRA(run, target);
  await checkIPv6Off(run, target, subnet);
  await checkRouterAdvertClient(run, target);
  await checkOldHostReruns(run, target);
  await runInContainer(run, ['ip', 'link', 'del', FAKE_UPLINK]);
}

async function checkNetworkRecreated(
  run: BootstrapRun,
  target: BootstrapTarget,
  subnet: string,
): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] ipv6: a network with another subnet is drift, and a run recreates it`);

  await runInContainer(run, ['systemctl', 'stop', 'imp-host']);
  await runInContainer(run, ['docker', 'network', 'rm', 'imp-host']);

  await runInContainer(run, [
    'docker',
    'network',
    'create',
    '--ipv6',
    '--subnet',
    'fd00:dead:beef::/64',
    '-o',
    'com.docker.network.bridge.name=br-imphost',
    'imp-host',
  ]);

  const plan = await expectBootstrapExit(run, target, { want: 2, mode: '--check' });

  const recreate = `would: recreate the imp-host network (its IPv6 subnet is fd00:dead:beef::/64, not ${subnet})`;

  if (!plan.includes(recreate)) {
    throw new BootstrapTestError(`[${distro}] --check did not plan to recreate the network`);
  }

  await applyBootstrap(run, target, { failure: 'the run that recreates the network failed' });

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running on the recreated network`);
  }

  await checkIPv6On(run, target);
}

async function checkAcceptRA(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;
  const sysctl = `net/ipv6/conf/${FAKE_UPLINK}/accept_ra`;

  run.log(
    `[${distro}] ipv6: a router-advert route the kernel takes gets accept_ra=2, on a dotted name`,
  );

  await runInContainer(run, ['ip', 'link', 'add', FAKE_UPLINK, 'type', 'dummy']);
  await runInContainer(run, ['ip', 'link', 'set', FAKE_UPLINK, 'up']);

  await runInContainer(run, [
    'ip',
    '-6',
    'addr',
    'add',
    '2001:db8:ffff::2/64',
    'dev',
    FAKE_UPLINK,
    'nodad',
  ]);

  await runInContainer(run, [
    'ip',
    '-6',
    'route',
    'add',
    'default',
    'via',
    '2001:db8:ffff::1',
    'dev',
    FAKE_UPLINK,
    'proto',
    'ra',
  ]);

  await runInContainer(run, ['sysctl', '-qw', `${sysctl}=1`]);

  const plan = await expectBootstrapExit(run, target, { want: 2, mode: '--check' });

  if (!plan.includes(`would: sysctl ${sysctl}=2`)) {
    throw new BootstrapTestError(`[${distro}] --check did not plan accept_ra=2`);
  }

  await applyBootstrap(run, target, { failure: 'the accept_ra run failed' });

  await expectInContainer(run, {
    argv: ['grep', '-qx', `${sysctl} = 2`, '/etc/sysctl.d/90-imp-ipv6.conf'],
    failure: `[${distro}] the accept_ra file does not name ${FAKE_UPLINK}`,
  });

  const acceptRA = await readInContainer(run, ['cat', `/proc/sys/${sysctl}`]);

  if (acceptRA.output !== '2') {
    throw new BootstrapTestError(`[${distro}] accept_ra is not 2`);
  }

  const again = await applyBootstrap(run, target, { failure: 'the second accept_ra run failed' });

  if (!again.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] accept_ra is not idempotent`);
  }

  const auto = await expectBootstrapExit(run, target, {
    want: 0,
    mode: '--check',
    extra: ['--ipv6', 'auto'],
  });

  if (!auto.includes(`ipv6: on (auto: ${FAKE_UPLINK} has a global IPv6 default route)`)) {
    throw new BootstrapTestError(`[${distro}] auto did not see ${FAKE_UPLINK}`);
  }
}

async function checkIPv6Off(
  run: BootstrapRun,
  target: BootstrapTarget,
  subnet: string,
): Promise<void> {
  const distro = target.distro;
  const off = ['--ipv6', 'off'];

  run.log(`[${distro}] ipv6: --ipv6 off removes the network and the accept_ra file`);

  const plan = await expectBootstrapExit(run, target, { want: 2, mode: '--check', extra: off });

  if (!plan.includes('would: stop imp-host and remove the imp-host network')) {
    throw new BootstrapTestError(`[${distro}] --check did not plan the removal`);
  }

  await applyBootstrap(run, target, { extra: off, failure: 'the --ipv6 off run failed' });

  await expectInContainer(run, {
    argv: ['docker', 'network', 'inspect', 'imp-host'],
    failure: `[${distro}] the imp-host network is left`,
    fails: true,
  });

  await expectInContainer(run, {
    argv: ['test', '!', '-e', '/etc/sysctl.d/90-imp-ipv6.conf'],
    failure: `[${distro}] the accept_ra file is left`,
  });

  const isOff =
    (await readEnvValue(run, 'IMP_HOST_IPV6')) === 'off' &&
    (await readEnvValue(run, 'IMP_HOST_NETWORK')) === '';

  if (!isOff) {
    throw new BootstrapTestError(`[${distro}] the env file is not off`);
  }

  if ((await readEnvValue(run, 'IMP_HOST_SUBNET6')) !== subnet) {
    throw new BootstrapTestError(`[${distro}] off dropped the subnet`);
  }

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running with --ipv6 off`);
  }

  if ((await readImpHostNetworks(run)) !== 'bridge') {
    throw new BootstrapTestError(`[${distro}] imp-host is not on the default bridge`);
  }

  const again = await applyBootstrap(run, target, { failure: 'the second off run failed' });

  if (!again.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] off is not idempotent`);
  }

  run.log(`[${distro}] ipv6: a network that comes back is drift, and --yes refuses it`);

  await runInContainer(run, ['docker', 'network', 'create', 'imp-host']);
  await expectBootstrapExit(run, target, { want: 2, mode: '--check' });

  const refusal = await expectBootstrapExit(run, target, { want: 1, mode: '--yes' });

  if (!refusal.includes('run with --ipv6 off to remove them')) {
    throw new BootstrapTestError(`[${distro}] no hint for the drift`);
  }

  await runInContainer(run, ['docker', 'network', 'rm', 'imp-host']);
}

async function checkRouterAdvertClient(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] ipv6: a client that takes router adverts stops on, unless --ra-handled`);

  await runInContainer(run, ['sysctl', '-qw', `net/ipv6/conf/${FAKE_UPLINK}/accept_ra=0`]);

  const refusal = await expectBootstrapExit(run, target, {
    want: 1,
    mode: '--check',
    extra: ['--ipv6', 'on'],
  });

  const outsideKernel = `the IPv6 default route on ${FAKE_UPLINK} comes from router adverts that a client other than the kernel takes`;

  if (!refusal.includes(outsideKernel)) {
    throw new BootstrapTestError(`[${distro}] no refusal for router adverts outside the kernel`);
  }

  await applyBootstrap(run, target, {
    extra: ['--ipv6', 'on', '--ra-handled'],
    failure: 'the --ra-handled run failed',
  });

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running after --ra-handled`);
  }

  await checkIPv6On(run, target);

  const later = await applyBootstrap(run, target, { failure: 'the run after --ra-handled failed' });

  if (!later.includes('IPv6 was on already')) {
    throw new BootstrapTestError(`[${distro}] a later run did not accept the network`);
  }

  if (!later.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] the run after --ra-handled changed something`);
  }
}

async function checkOldHostReruns(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;
  const sysctl = `net/ipv6/conf/${FAKE_UPLINK}/accept_ra`;

  run.log(
    `[${distro}] ipv6: an older host whose adverts a client takes re-runs into auto, which warns and stays off`,
  );

  await revertToOldHost(run, target);
  await runInContainer(run, ['sysctl', '-qw', `${sysctl}=0`]);

  const warned = await applyBootstrap(run, target, {
    failure: 'the re-run of an older host failed',
  });

  if (
    !warned.includes(`WARNING: the IPv6 default route on ${FAKE_UPLINK} comes from router adverts`)
  ) {
    throw new BootstrapTestError(`[${distro}] auto did not warn about the router adverts`);
  }

  if ((await readEnvValue(run, 'IMP_HOST_IPV6')) !== 'off') {
    throw new BootstrapTestError(`[${distro}] auto did not record off`);
  }

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running after the re-run`);
  }

  if ((await readImpHostNetworks(run)) !== 'bridge') {
    throw new BootstrapTestError(`[${distro}] imp-host left the default bridge`);
  }

  run.log(
    `[${distro}] ipv6: an older host whose adverts the kernel takes re-runs into auto, which turns IPv6 on`,
  );

  await revertToOldHost(run, target);
  await runInContainer(run, ['sysctl', '-qw', `${sysctl}=1`]);

  const turnedOn = await applyBootstrap(run, target, {
    failure: 'the re-run of an older host failed',
  });

  if (!turnedOn.includes(`ipv6: on (auto: ${FAKE_UPLINK} has a global IPv6 default route)`)) {
    throw new BootstrapTestError(`[${distro}] auto did not turn on`);
  }

  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] imp-host is not running after the re-run`);
  }

  await checkIPv6On(run, target);
}
