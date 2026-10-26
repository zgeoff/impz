import { applyBootstrap } from './apply-bootstrap';
import { BootstrapTestError } from './bootstrap-test-error';
import { expectInContainer } from './expect-in-container';
import { runInContainer } from './run-in-container';
import type { BootstrapRun, BootstrapTarget } from './types';

const PROXY_UNIT = '/etc/systemd/system/imp-docker-proxy.service';

export async function checkProxyRetired(run: BootstrapRun, target: BootstrapTarget): Promise<void> {
  const distro = target.distro;

  run.log(`[${distro}] a rerun stops, disables and removes an enabled legacy imp-docker-proxy`);

  await runInContainer(run, [
    'bash',
    '-c',
    `printf '[Service]\\nExecStart=/bin/sleep infinity\\n\\n[Install]\\nWantedBy=multi-user.target\\n' > ${PROXY_UNIT}`,
  ]);

  await runInContainer(run, ['systemctl', 'daemon-reload']);
  await runInContainer(run, ['systemctl', 'enable', '-q', '--now', 'imp-docker-proxy']);

  await expectInContainer(run, {
    argv: ['systemctl', 'is-active', '-q', 'imp-docker-proxy'],
    failure: `[${distro}] the legacy imp-docker-proxy did not start`,
  });

  const output = await applyBootstrap(run, target, {
    failure: 'the run over a legacy imp-docker-proxy failed',
  });

  if (!output.includes('change: remove imp-docker-proxy, which impd no longer calls')) {
    throw new BootstrapTestError(`[${distro}] the run did not report the proxy's removal`);
  }

  await expectInContainer(run, {
    argv: ['systemctl', 'is-active', '-q', 'imp-docker-proxy'],
    failure: `[${distro}] imp-docker-proxy is still active`,
    fails: true,
  });

  await expectInContainer(run, {
    argv: ['systemctl', 'is-enabled', '-q', 'imp-docker-proxy'],
    failure: `[${distro}] imp-docker-proxy is still enabled`,
    fails: true,
  });

  await expectInContainer(run, {
    argv: ['test', '!', '-e', PROXY_UNIT],
    failure: `[${distro}] ${PROXY_UNIT} is left`,
  });
}
