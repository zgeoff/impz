import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubFailingSystemctl } from './build-stub-failing-systemctl';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-failing-systemctl-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it fails the verb it names with the message systemd prints', () => {
  const ctx = setupTest();

  const systemctl = createStubBin(
    ctx.directoryPath,
    'systemctl',
    buildStubFailingSystemctl('start'),
  );

  const result = Bun.spawnSync(['systemctl', 'start', 'imp-host'], {
    env: { PATH: `${systemctl.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({
    exitCode: 1,
    stdout: '',
    stderr: 'Job for imp-host.service failed because the control process exited with error code.\n',
  });
});

test('it answers every other verb with success and records each call', () => {
  const ctx = setupTest();

  const systemctl = createStubBin(
    ctx.directoryPath,
    'systemctl',
    buildStubFailingSystemctl('start'),
  );

  const result = Bun.spawnSync(
    ['bash', '-c', 'systemctl stop imp-host && systemctl daemon-reload'],
    { env: { PATH: `${systemctl.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(systemctl.calls, 'utf8')).toBe(
    'systemctl stop imp-host\nsystemctl daemon-reload\n',
  );
});
