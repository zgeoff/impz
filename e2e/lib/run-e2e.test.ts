import { expect, mock, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from './instance';
import type { HarnessDeps } from './run-e2e';
import { runE2E } from './run-e2e';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'run-e2e-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const deps = {
    readHostImage: mock<HarnessDeps['readHostImage']>(),
    readTailscaleKey: mock<HarnessDeps['readTailscaleKey']>(),
    setUpInstance: mock<HarnessDeps['setUpInstance']>(),
    recreateInstance: mock<HarnessDeps['recreateInstance']>(),
    resetSuites: mock<HarnessDeps['resetSuites']>(),
    rebootInstance: mock<HarnessDeps['rebootInstance']>(),
    runJourney: mock<HarnessDeps['runJourney']>(),
    stopJourney: mock<HarnessDeps['stopJourney']>(),
    readImpdLogTail: mock<HarnessDeps['readImpdLogTail']>(),
    readImpdLogSince: mock<HarnessDeps['readImpdLogSince']>(),
    readHostBFixture: mock<HarnessDeps['readHostBFixture']>(),
    removeLeftovers: mock<HarnessDeps['removeLeftovers']>(),
    stopPebble: mock<HarnessDeps['stopPebble']>(),
    onSignal: mock<HarnessDeps['onSignal']>(),
    exit: mock<HarnessDeps['exit']>(),
    now: mock<HarnessDeps['now']>(),
    log: mock<HarnessDeps['log']>(),
    warn: mock<HarnessDeps['warn']>(),
  };

  return { resultsDir: join(directory, 'results'), deps };
}

test('it prints the usage for --help and touches nothing', async () => {
  const ctx = setupTest();

  const exitCode = await runE2E({
    argv: ['--help'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: ctx.resultsDir,
    deps: ctx.deps,
  });

  expect(exitCode).toBe(0);

  expect(ctx.deps.log).toHaveBeenCalledExactlyOnceWith(
    expect.toStartWith('imp end-to-end harness'),
  );

  expect(ctx.deps.readHostImage).not.toHaveBeenCalled();
  expect(ctx.deps.setUpInstance).not.toHaveBeenCalled();
});

test('it refuses an unknown flag with the usage and exit code 2', async () => {
  const ctx = setupTest();

  const exitCode = await runE2E({
    argv: ['--fast'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: ctx.resultsDir,
    deps: ctx.deps,
  });

  expect(exitCode).toBe(2);
  expect(ctx.deps.warn).toHaveBeenCalledWith(expect.toStartWith('test-e2e: '));
  expect(ctx.deps.setUpInstance).not.toHaveBeenCalled();
});

test('it records a failed setup and runs no journey', async () => {
  const ctx = setupTest();

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.setUpInstance.mockRejectedValue(new Error('scripts/dev/dev.sh up exited 1'));
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  const exitCode = await runE2E({
    argv: ['--only', 'docker'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: ctx.resultsDir,
    deps: ctx.deps,
  });

  const results: unknown = JSON.parse(readFileSync(join(ctx.resultsDir, 'results.json'), 'utf8'));

  expect(exitCode).toBe(1);
  expect(ctx.deps.warn).toHaveBeenCalledWith('    FAIL: scripts/dev/dev.sh up exited 1');
  expect(ctx.deps.runJourney).not.toHaveBeenCalled();

  expect(results).toStrictEqual({
    runAt: '2026-01-01T00:00:00.000Z',
    ramBudgetMib: 6144,
    idleTimeoutS: 10,
    section0: { name: 'setup', verdict: 'FAIL', durationMs: 0 },
  });
});

test('it sets the instance up with the harness env and leaves its own env unchanged', async () => {
  const ctx = setupTest();
  const env = { PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key' };

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.setUpInstance.mockRejectedValue(new Error('scripts/dev/dev.sh up exited 1'));
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  await runE2E({
    argv: ['--only', 'docker'],
    env,
    bunPath: '/usr/local/bin/bun',
    resultsDir: ctx.resultsDir,
    deps: ctx.deps,
  });

  expect(ctx.deps.setUpInstance).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      env: {
        PATH: '/usr/bin',
        IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
        IMP_RAM_BUDGET_MIB: '6144',
        IMP_IDLE_TIMEOUT_S: '10',
        IMP_DEV_TAILNET: '0',
      },
    }),
  );

  expect(env).toStrictEqual({ PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key' });
});

test('it hands each journey the token of the instance it set up', async () => {
  const ctx = setupTest();
  const metricsFile = join(ctx.resultsDir, 'metrics.jsonl');

  const instance = createInstance({
    container: 'imp-e2e-a',
    dataDir: '/var/tmp/imp-e2e-a',
    network: 'imp-e2e-a-net',
    ip: '10.100.0.10',
  });

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.setUpInstance.mockResolvedValue({ ...instance, token: 'fake-run-token' });
  ctx.deps.runJourney.mockResolvedValue(0);
  ctx.deps.readImpdLogSince.mockResolvedValue('');
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  const exitCode = await runE2E({
    argv: ['--only', 'docker', '--keep'],
    env: { PATH: '/usr/bin' },
    bunPath: '/usr/local/bin/bun',
    resultsDir: ctx.resultsDir,
    deps: ctx.deps,
  });

  expect(exitCode).toBe(0);

  expect(ctx.deps.runJourney).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      argv: expect.arrayContaining(['/usr/local/bin/bun', 'test']) as unknown,
      env: expect.objectContaining({
        IMP_TOKEN: 'fake-run-token',
        IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
        E2E_KEEP: '1',
        E2E_METRICS_FILE: metricsFile,
      }) as unknown,
    }),
  );
});
