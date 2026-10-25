import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubUnitSystemctl } from './build-stub-unit-systemctl';
import { createStubBin } from './create-stub-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-unit-systemctl-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
  };
}

test('it logs the ExecStart line of the unit as it is at each call', () => {
  const ctx = setupTest();
  const unit = join(ctx.directoryPath, 'imp-host.service');
  const systemctl = createStubBin(ctx.directoryPath, 'systemctl', buildStubUnitSystemctl(unit));

  writeFileSync(unit, '[Service]\nExecStart=/usr/bin/docker run imp-host\nExecStart=second\n');

  const result = Bun.spawnSync(
    [
      'bash',
      '-c',
      `systemctl stop imp-host; printf 'ExecStart=/usr/bin/podman run imp-host\\n' >${unit}; ` +
        'systemctl start imp-host',
    ],
    { env: { PATH: `${systemctl.bin}:${process.env['PATH'] ?? ''}` } },
  );

  expect(result.exitCode).toBe(0);

  expect(readFileSync(systemctl.calls, 'utf8')).toBe(
    'systemctl stop imp-host\n  unit: ExecStart=/usr/bin/docker run imp-host\n' +
      'systemctl start imp-host\n  unit: ExecStart=/usr/bin/podman run imp-host\n',
  );
});

test('it logs none when the unit is missing', () => {
  const ctx = setupTest();

  const systemctl = createStubBin(
    ctx.directoryPath,
    'systemctl',
    buildStubUnitSystemctl(join(ctx.directoryPath, 'imp-host.service')),
  );

  const result = Bun.spawnSync(['systemctl', 'daemon-reload'], {
    env: { PATH: `${systemctl.bin}:${process.env['PATH'] ?? ''}` },
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(systemctl.calls, 'utf8')).toBe('systemctl daemon-reload\n  unit: none\n');
});
