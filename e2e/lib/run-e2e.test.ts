import { expect, mock, test } from 'bun:test';
import { createInstance } from './instance';
import type { HarnessDeps } from './run-e2e';
import { runE2E } from './run-e2e';

function setupTest() {
  const deps = {
    readHostImage: mock<HarnessDeps['readHostImage']>(),
    readTailscaleKey: mock<HarnessDeps['readTailscaleKey']>(),
    startHeadscale: mock<HarnessDeps['startHeadscale']>(),
    stopHeadscale: mock<HarnessDeps['stopHeadscale']>(),
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
    createDirectory: mock<HarnessDeps['createDirectory']>(),
    removeFile: mock<HarnessDeps['removeFile']>(),
    writeResults: mock<HarnessDeps['writeResults']>(),
    onSignal: mock<HarnessDeps['onSignal']>(),
    exit: mock<HarnessDeps['exit']>(),
    now: mock<HarnessDeps['now']>(),
    log: mock<HarnessDeps['log']>(),
    warn: mock<HarnessDeps['warn']>(),
  };

  return { deps };
}

test('it prints the usage for --help and touches nothing', async () => {
  const ctx = setupTest();

  const exitCode = await runE2E({
    argv: ['--help'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(exitCode).toBe(0);

  expect(ctx.deps.log).toHaveBeenCalledExactlyOnceWith(
    expect.toStartWith('imp end-to-end harness'),
  );

  expect(ctx.deps.readHostImage).not.toHaveBeenCalled();
  expect(ctx.deps.setUpInstance).not.toHaveBeenCalled();
  expect(ctx.deps.createDirectory).not.toHaveBeenCalled();
});

test('it refuses an unknown flag with the usage and exit code 2', async () => {
  const ctx = setupTest();

  const exitCode = await runE2E({
    argv: ['--fast'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(exitCode).toBe(2);
  expect(ctx.deps.warn).toHaveBeenCalledWith(expect.toStartWith('test-e2e: '));
  expect(ctx.deps.setUpInstance).not.toHaveBeenCalled();
});

test('it makes the results folder and drops the last run metrics before it sets up', async () => {
  const ctx = setupTest();

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.setUpInstance.mockRejectedValue(new Error('scripts/dev/dev.sh up exited 1'));
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  await runE2E({
    argv: ['--only', 'docker'],
    env: {},
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(ctx.deps.createDirectory).toHaveBeenCalledExactlyOnceWith('/var/tmp/imp-e2e-results');

  expect(ctx.deps.removeFile).toHaveBeenCalledExactlyOnceWith(
    '/var/tmp/imp-e2e-results/metrics.jsonl',
  );

  expect(ctx.deps.removeFile).toHaveBeenCalledBefore(ctx.deps.setUpInstance);
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
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(exitCode).toBe(1);
  expect(ctx.deps.warn).toHaveBeenCalledWith('    FAIL: scripts/dev/dev.sh up exited 1');
  expect(ctx.deps.runJourney).not.toHaveBeenCalled();

  expect(ctx.deps.writeResults).toHaveBeenCalledExactlyOnceWith(
    [{ index: 0, name: 'setup', verdict: 'FAIL', durationMs: 0 }],
    {
      resultsFile: '/var/tmp/imp-e2e-results/results.json',
      metricsFile: '/var/tmp/imp-e2e-results/metrics.jsonl',
      ramBudgetMib: 6144,
      idleTimeoutS: 10,
      now: expect.any(Function),
    },
  );
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
    resultsDir: '/var/tmp/imp-e2e-results',
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

test('it gives the Headscale key, never the dev key, to setup, host B and each journey', async () => {
  const ctx = setupTest();

  const instance = createInstance({
    container: 'imp-e2e-a',
    dataDir: '/var/tmp/imp-e2e-a',
    network: 'imp-e2e-a-net',
    ip: '10.100.0.10',
  });

  const fixture = {
    start: mock(async () => {}),
    reset: mock(async () => {}),
    stop: mock(async () => {}),
  };

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');

  ctx.deps.startHeadscale.mockResolvedValue({
    key: 'fake-headscale-key',
    network: 'imp-e2e-a-ts',
    member: 'imp-e2e-a-ts-member',
  });

  ctx.deps.setUpInstance.mockResolvedValue({ ...instance, token: 'fake-run-token' });
  ctx.deps.readHostBFixture.mockReturnValue(fixture);
  ctx.deps.runJourney.mockResolvedValue(0);
  ctx.deps.readImpdLogSince.mockResolvedValue('');
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  await runE2E({
    argv: ['--only', 'moves-tailnet', '--keep'],
    env: { PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key' },
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  const tailnetEnv = {
    PATH: '/usr/bin',
    IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
    IMP_RAM_BUDGET_MIB: '6144',
    IMP_IDLE_TIMEOUT_S: '10',
    TAILSCALE_AUTHKEY: 'fake-headscale-key',
    IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
    IMP_TAILSCALE_LOGIN_SERVER: 'http://headscale:8080',
    IMP_TAILSCALE_STATE_DIR: 'mem',
    IMP_DEV_NETWORK: 'imp-e2e-a-ts',
    E2E_TAILNET_MEMBER: 'imp-e2e-a-ts-member',
  };

  expect(ctx.deps.setUpInstance).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ env: tailnetEnv }),
  );

  expect(ctx.deps.readHostBFixture).toHaveBeenCalledWith(
    'host-b-tailnet',
    expect.objectContaining({ env: tailnetEnv }),
  );

  expect(ctx.deps.runJourney.mock.calls.map((call) => call[0].env)).toStrictEqual([
    expect.objectContaining(tailnetEnv),
  ]);

  expect(ctx.deps.readTailscaleKey).not.toHaveBeenCalled();
});

test('it removes the run’s Headscale once the suites are done', async () => {
  const ctx = setupTest();

  const instance = createInstance({
    container: 'imp-e2e-a',
    dataDir: '/var/tmp/imp-e2e-a',
    network: 'imp-e2e-a-net',
    ip: '10.100.0.10',
  });

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');

  ctx.deps.startHeadscale.mockResolvedValue({
    key: 'fake-headscale-key',
    network: 'imp-e2e-a-ts',
    member: 'imp-e2e-a-ts-member',
  });

  ctx.deps.setUpInstance.mockResolvedValue({ ...instance, token: 'fake-run-token' });
  ctx.deps.runJourney.mockResolvedValue(0);
  ctx.deps.readImpdLogSince.mockResolvedValue('');
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  await runE2E({
    argv: ['--only', 'egress', '--keep'],
    env: { PATH: '/usr/bin' },
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(ctx.deps.stopHeadscale).toHaveBeenCalledOnce();
  expect(ctx.deps.stopHeadscale).toHaveBeenCalledAfter(ctx.deps.runJourney);
});

test('it removes a Headscale that did not start and sets nothing up', async () => {
  const ctx = setupTest();

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.startHeadscale.mockRejectedValue(new Error('docker start imp-e2e-a-headscale exited 1'));

  const exitCode = await runE2E({
    argv: ['--only', 'tailscale'],
    env: { PATH: '/usr/bin' },
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(exitCode).toBe(1);

  expect(ctx.deps.warn).toHaveBeenCalledWith(
    'test-e2e: the Headscale tailnet did not start: docker start imp-e2e-a-headscale exited 1',
  );

  expect(ctx.deps.stopHeadscale).toHaveBeenCalledOnce();
  expect(ctx.deps.setUpInstance).not.toHaveBeenCalled();
});

test('it gives the e2e Tailscale key to setup and each journey of the names suite once its names are on', async () => {
  const ctx = setupTest();

  const instance = createInstance({
    container: 'imp-e2e-a',
    dataDir: '/var/tmp/imp-e2e-a',
    network: 'imp-e2e-a-net',
    ip: '10.100.0.10',
  });

  ctx.deps.readHostImage.mockReturnValue('imp-host:dev-imp-0f3a91c2');
  ctx.deps.readTailscaleKey.mockResolvedValue({ key: 'fake-e2e-key', tags: 'tag:imp-e2e' });
  ctx.deps.setUpInstance.mockResolvedValue({ ...instance, token: 'fake-run-token' });
  ctx.deps.runJourney.mockResolvedValue(0);
  ctx.deps.readImpdLogSince.mockResolvedValue('');
  ctx.deps.now.mockReturnValue(1_767_225_600_000);

  await runE2E({
    argv: ['--only', 'tailnet-names', '--keep'],
    env: { PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-dev-key', IMP_E2E_TAILNET_NAMES: '1' },
    bunPath: '/usr/local/bin/bun',
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  const tailnetEnv = {
    PATH: '/usr/bin',
    IMP_E2E_TAILNET_NAMES: '1',
    IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
    IMP_RAM_BUDGET_MIB: '6144',
    IMP_IDLE_TIMEOUT_S: '10',
    TAILSCALE_AUTHKEY: 'fake-e2e-key',
    IMP_TAILSCALE_TAGS: 'tag:imp-e2e',
  };

  expect(ctx.deps.setUpInstance).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ env: tailnetEnv }),
  );

  expect(ctx.deps.runJourney.mock.calls.map((call) => call[0].env)).toStrictEqual([
    expect.objectContaining(tailnetEnv),
    expect.objectContaining(tailnetEnv),
  ]);

  expect(ctx.deps.startHeadscale).not.toHaveBeenCalled();
});

test('it runs each journey with its full argv and the env of the instance it set up', async () => {
  const ctx = setupTest();

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
    resultsDir: '/var/tmp/imp-e2e-results',
    deps: ctx.deps,
  });

  expect(exitCode).toBe(0);

  expect(ctx.deps.runJourney).toHaveBeenCalledExactlyOnceWith({
    argv: [
      '/usr/local/bin/bun',
      'test',
      '--config=e2e/bunfig.toml',
      '--bail',
      '--timeout',
      '3600000',
      './e2e/suites/docker.e2e.ts',
    ],
    env: {
      PATH: '/usr/bin',
      IMP_HOST_IMAGE: 'imp-host:dev-imp-0f3a91c2',
      IMP_RAM_BUDGET_MIB: '6144',
      IMP_IDLE_TIMEOUT_S: '10',
      IMP_DEV_TAILNET: '0',
      IMP_TOKEN: 'fake-run-token',
      E2E_KEEP: '1',
      E2E_KEPT_PREFIXES: '',
      E2E_ACCEPTANCE: '0',
      E2E_METRICS_FILE: '/var/tmp/imp-e2e-results/metrics.jsonl',
    },
    onStart: expect.any(Function),
  });
});
