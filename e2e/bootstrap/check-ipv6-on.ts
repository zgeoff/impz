import { BootstrapTestError } from './bootstrap-test-error';
import { readEnvValue } from './read-env-value';
import { readImpHostNetworks } from './read-imp-host-networks';
import { readInContainer } from './read-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

export async function checkIPv6On(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  const subnet = await readEnvValue(run, 'IMP_HOST_SUBNET6');

  if (subnet === '') {
    throw new BootstrapTestError(`[${distro}] the env file has no IMP_HOST_SUBNET6`);
  }

  if ((await readEnvValue(run, 'IMP_HOST_IPV6')) !== 'on') {
    throw new BootstrapTestError(`[${distro}] the env file does not say IMP_HOST_IPV6=on`);
  }

  if ((await readEnvValue(run, 'IMP_HOST_NETWORK')) !== '--network imp-host') {
    throw new BootstrapTestError(`[${distro}] IMP_HOST_NETWORK does not name imp-host`);
  }

  const bridge = await readInContainer(run, [
    'docker',
    'network',
    'inspect',
    '-f',
    '{{.EnableIPv6}} {{index .Options "com.docker.network.bridge.name"}}',
    'imp-host',
  ]);

  if (bridge.output !== 'true br-imphost') {
    throw new BootstrapTestError(`[${distro}] the imp-host network is not IPv6 on br-imphost`);
  }

  const subnets = await readInContainer(run, [
    'docker',
    'network',
    'inspect',
    '-f',
    '{{range .IPAM.Config}} {{.Subnet}}{{end}} ',
    'imp-host',
  ]);

  if (!subnets.output.includes(` ${subnet} `)) {
    throw new BootstrapTestError(`[${distro}] the imp-host network is not on ${subnet}`);
  }

  if ((await readImpHostNetworks(run)) !== 'imp-host') {
    throw new BootstrapTestError(
      `[${distro}] the imp-host container is not on the imp-host network alone`,
    );
  }

  const route = await readImpHostRoute6(run);

  if (route === '') {
    throw new BootstrapTestError(`[${distro}] imp-host has no IPv6 default route`);
  }

  run.log(`[${distro}] imp-host's IPv6 default route: ${route}`);
}

// The stub image has no ip, so the route is read from imp-host's network namespace.
async function readImpHostRoute6(run: BootstrapRun): Promise<string> {
  const pid = await runInContainer(run, [
    'docker',
    'container',
    'inspect',
    '-f',
    '{{.State.Pid}}',
    'imp-host',
  ]);

  return runInContainer(run, ['nsenter', '-t', pid, '-n', 'ip', '-6', 'route', 'show', 'default']);
}
