import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { checkFirewallDrops } from './check-firewall-drops';
import { checkHostFirewallNone } from './check-host-firewall-none';
import { checkImpEgress6 } from './check-imp-egress6';
import { checkIPv6Cases } from './check-ipv6-cases';
import { checkIPv6On } from './check-ipv6-on';
import { checkStaleImage } from './check-stale-image';
import type { Distro } from './distros';
import { expectBootstrapExit } from './expect-bootstrap-exit';
import { expectInContainer } from './expect-in-container';
import { readInContainer } from './read-in-container';
import { removeTestContainer } from './remove-test-container';
import { runInContainer } from './run-in-container';
import { startTestContainer } from './start-test-container';
import { STORAGE_PATHS } from './storage-paths';
import type { BootstrapRun, BootstrapTarget } from './types';
import { waitForImpHost } from './wait-for-imp-host';

export async function runDistroLeg(run: BootstrapRun, distro: Distro): Promise<void> {
  await startTestContainer(run, distro);

  const target: BootstrapTarget = {
    distro,
    storage: ['--loop-file', STORAGE_PATHS.loopFile, '--loop-size', '50'],
    health: run.args.health,
  };

  const isUbuntu = distro !== 'debian';

  if (isUbuntu) {
    await runInContainer(run, ['ufw', '--force', 'enable']);
  }

  if (distro === 'ubuntu26') {
    await checkUbuntuZfsPlan(run, target);
  }

  run.log(`[${distro}] --check on the fresh host`);

  const plan = await expectBootstrapExit(run, target, {
    want: 2,
    mode: '--check',

    // CI has no IPv6 route out, so auto would say off.
    extra: ['--ipv6', 'on'],
  });

  await expectInContainer(run, {
    argv: ['test', '!', '-e', '/etc/imp'],
    failure: `[${distro}] --check changed the host`,
  });

  if (!plan.includes('would: create the imp-host network')) {
    throw new BootstrapTestError(`[${distro}] --check did not plan the network`);
  }

  run.log(`[${distro}] first run`);

  // Later runs keep on from the env file.
  const first = await applyBootstrap(run, target, {
    extra: ['--ipv6', 'on'],
    failure: 'the first run failed',
  });

  if (run.args.stub) {
    await checkKeyBlanked(run, distro, first);
  }

  await checkFirstRun(run, distro, isUbuntu);
  await checkFirewallDrops(run);
  await checkIPv6On(run, target);

  if (target.health) {
    await checkImpEgress6(run, target);
  }

  run.log(`[${distro}] --check after the first run`);

  await expectBootstrapExit(run, target, { want: 0, mode: '--check' });

  run.log(`[${distro}] second run`);

  const second = await applyBootstrap(run, target, { failure: 'the second run failed' });

  if (!second.includes('bootstrap: 0 change(s) made')) {
    throw new BootstrapTestError(`[${distro}] the second run changed something`);
  }

  if (run.args.stub) {
    await checkStaleImage(run, target);
  }

  await checkHostFirewallNone(run, target);

  if (distro === 'debian') {
    await checkIPv6Cases(run, target);
  }

  await removeTestContainer(run);

  run.log(`[${distro}] passed`);
}

// Ubuntu ships the zfs module with its kernel: no contrib, no dkms.
async function checkUbuntuZfsPlan(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;
  const disk = STORAGE_PATHS.diskEmpty;

  run.log(`[${distro}] --storage zfs --check on an empty device`);

  const device = await runInContainer(run, [
    'bash',
    '-c',
    `truncate -s 20G ${disk} && losetup -f --show ${disk}`,
  ]);

  const plan = await expectBootstrapExit(
    run,
    { ...target, storage: ['--storage', 'zfs', '--data-device', device] },
    { want: 2, mode: '--check' },
  );

  const wanted = [
    'would: apt-get install zfsutils-linux',
    `would: zpool create tank on ${device}`,
    'would: zfs create tank/imp (mountpoint=legacy)',
    'would: write /etc/modprobe.d/imp-zfs.conf',
  ];

  for (const want of wanted) {
    if (!plan.includes(want)) {
      throw new BootstrapTestError(`[${distro}] --check with zfs did not plan: ${want}`);
    }
  }

  if (/zfs-dkms|linux-headers|contrib/u.test(plan)) {
    throw new BootstrapTestError(`[${distro}] zfs on Ubuntu planned dkms`);
  }

  await runInContainer(run, ['losetup', '-d', device]);
}

async function checkKeyBlanked(run: BootstrapRun, distro: Distro, output: string): Promise<void> {
  if (output.includes(run.fakeKey)) {
    throw new BootstrapTestError(`[${distro}] bootstrap.sh printed the Tailscale key`);
  }

  if (!output.includes('change: blank TAILSCALE_AUTHKEY')) {
    throw new BootstrapTestError(`[${distro}] the key was not blanked`);
  }

  await expectInContainer(run, {
    argv: ['grep', '-qx', 'TAILSCALE_AUTHKEY=', '/etc/imp/imp-host.env'],
    failure: `[${distro}] imp-host.env still holds a Tailscale key`,
  });

  const env = await readInContainer(run, [
    'docker',
    'container',
    'inspect',
    '-f',
    '{{.Config.Env}}',
    'imp-host',
  ]);

  if (env.output.includes(run.fakeKey)) {
    throw new BootstrapTestError(
      `[${distro}] the running imp-host still has the Tailscale key in its environment`,
    );
  }

  if (!output.includes('delete /mnt/archive/authkey now')) {
    throw new BootstrapTestError(`[${distro}] no reminder to delete the key file`);
  }
}

async function checkFirstRun(run: BootstrapRun, distro: Distro, isUbuntu: boolean): Promise<void> {
  if (!(await waitForImpHost(run))) {
    throw new BootstrapTestError(`[${distro}] the imp-host container is not running`);
  }

  await expectInContainer(run, {
    argv: ['systemctl', 'cat', 'imp-docker-proxy'],
    failure: `[${distro}] an imp-docker-proxy unit is installed`,
    fails: true,
  });

  const mounts = await readInContainer(run, [
    'docker',
    'container',
    'inspect',
    '-f',
    '{{range .Mounts}}{{.Source}} {{end}}',
    'imp-host',
  ]);

  if (mounts.output.includes('docker.sock')) {
    throw new BootstrapTestError(`[${distro}] imp-host mounts the host's docker.sock`);
  }

  await expectInContainer(run, {
    argv: ['systemctl', '-q', 'is-active', 'imp-firewall'],
    failure: `[${distro}] imp-firewall is not active`,
  });

  await expectInContainer(run, {
    argv: ['nft', 'list', 'table', 'inet', 'imp_host'],
    failure: `[${distro}] the firewall table is missing`,
  });

  const mode = await readInContainer(run, ['stat', '-c', '%a', '/etc/imp/imp-host.env']);

  if (mode.output !== '600') {
    throw new BootstrapTestError(`[${distro}] imp-host.env is not 0600`);
  }

  if (isUbuntu) {
    const ufw = await readInContainer(run, ['ufw', 'status']);

    if (!ufw.output.includes('Status: inactive')) {
      throw new BootstrapTestError(`[${distro}] ufw is still active`);
    }
  }
}
