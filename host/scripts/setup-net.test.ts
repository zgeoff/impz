import { expect, test } from 'bun:test';
import { join } from 'node:path';

// it changes nothing before the check, so it runs anywhere
test('it refuses to start without the settings host/entrypoint takes from impd', () => {
  const result = Bun.spawnSync(['bash', join(import.meta.dir, 'setup-net.sh')], {
    env: { PATH: process.env['PATH'] ?? '', IMP_SUBNET: '10.66.0.0/16', IMP_BROKER_PORT: '7081' },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr:
      'setup-net: IMP_EGRESS_DNS_PORT is unset; host/entrypoint sets it from impd --network-env\n',
  });
});
