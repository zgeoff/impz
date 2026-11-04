import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import invariant from 'tiny-invariant';
import { config } from './config';
import { REPO_ROOT, instance } from './instance';
import type { Suite } from './suites';
import {
  FAST_GROUPS,
  HOST_TESTS_GROUP,
  SUITES,
  SUITE_SETS,
  buildJourneyArgv,
  buildJourneyEnv,
  buildKsmSettings,
  getSuitePrefix,
  listJourneys,
  listZfsSuites,
  pickZfsShard,
  readSuiteSettings,
} from './suites';
import { findYamlValue } from './test-utils/find-yaml-value';

test('#buildJourneyArgv runs a journey file by a ./ path, which bun test does not read as a name filter', () => {
  expect(buildJourneyArgv('/usr/bin/bun', 'proxy-forwards')).toStrictEqual([
    '/usr/bin/bun',
    'test',
    '--config=packages/daemon/e2e/bunfig.toml',
    '--bail',
    '--timeout',
    '60000',
    './packages/daemon/e2e/cli-proxy-forwards.test.ts',
  ]);
});

test('#buildJourneyArgv runs a ZFS lane journey from its .zfs.test.ts file', () => {
  expect(buildJourneyArgv('/usr/bin/bun', 'moves-cold').at(-1)).toBe(
    './packages/daemon/e2e/journey-moves-cold.zfs.test.ts',
  );
});

test('#buildJourneyArgv throws for a journey with no file', () => {
  expect(() => buildJourneyArgv('/usr/bin/bun', 'no-such-journey')).toThrow();
});

test('#listZfsSuites lists the suites whose journey files all carry the .zfs suffix', () => {
  expect(listZfsSuites().map((suite) => suite.name)).toStrictEqual([
    'moves',
    'backups',
    'backups-repo',
  ]);
});

test('#listZfsSuites gives each ZFS suite its recorded time, which splits the shards', () => {
  expect(listZfsSuites().filter((suite) => suite.seconds === undefined)).toStrictEqual([]);
});

test.each([
  [1, 2, ['moves']],
  [2, 2, ['backups', 'backups-repo']],
  [1, 1, ['moves', 'backups', 'backups-repo']],
] as const)(
  '#pickZfsShard puts the ZFS suites of shard %p of %p, longest first, in %p',
  (index, count, suites) => {
    expect(pickZfsShard(index, count)).toStrictEqual(suites);
  },
);

test('#pickZfsShard puts each ZFS suite in exactly one shard', () => {
  const shards = [1, 2, 3].flatMap((index) => pickZfsShard(index, 3));

  expect(shards.toSorted()).toStrictEqual(
    listZfsSuites()
      .map((suite) => suite.name)
      .toSorted(),
  );
});

test('#listJourneys runs the file named for a suite that lists no journeys', () => {
  expect(listJourneys({ name: 'sleep', prefix: 'e2e-slp-', images: [] })).toStrictEqual(['sleep']);
});

test('#listJourneys runs the journeys a suite lists, in their order', () => {
  expect(
    listJourneys({
      name: 'proxy',
      prefix: 'e2e-px-',
      images: [],
      journeys: ['proxy-b', 'proxy-a'],
    }),
  ).toStrictEqual(['proxy-b', 'proxy-a']);
});

test('#getSuitePrefix reads the prefix of a suite', () => {
  expect(getSuitePrefix('templates')).toBe('e2e-tpl-');
});

test('#getSuitePrefix rejects a name that no suite has', () => {
  expect(() => getSuitePrefix('nope')).toThrowWithMessage(Error, 'no suite named nope');
});

test('#readSuiteSettings reads the settings a suite runs its journeys on', () => {
  expect(readSuiteSettings('tailscale', instance)).toStrictEqual({
    IMP_TAILNET_IDENTITIES: '[{"match":"*","scope":"read"}]',
  });
});

test('#readSuiteSettings puts the moves-tailnet suite beside host B on the move network', () => {
  expect(readSuiteSettings('moves-tailnet', instance)).toStrictEqual({
    IMP_RAM_BUDGET_MIB: '2048',
    IMP_DEFAULT_MEMORY_MIB: '512',
    IMP_DEV_NETWORK: `${instance.container}-mv`,
    IMP_DEV_IP: '10.100.0.10',
  });
});

test('#readSuiteSettings leaves the names suite on the run’s own settings while its names are off', () => {
  expect(readSuiteSettings('tailnet-names', instance)).toBeNull();
});

test('#readSuiteSettings reads null for a suite on the run’s own settings', () => {
  expect(readSuiteSettings('templates', instance)).toBeNull();
});

test("#readSuiteSettings opens the registry suite's registry to builders on an e2e impd", () => {
  expect(
    readSuiteSettings('registry', { ...instance, container: 'imp-dev-test', portOffset: 30 }),
  ).toStrictEqual({
    IMP_E2E: '1',
    IMP_BUILD_TEST_REGISTRY: `${config.registryName}:15473`,
    IMP_BUILD_TEST_REGISTRY_CA: join(
      REPO_ROOT,
      '.cache',
      'e2e',
      'imp-dev-test-registry-tls',
      'cert.pem',
    ),
  });
});

test('#readSuiteSettings puts the sleep suite on a 5 s idle timeout', () => {
  expect(readSuiteSettings('sleep', instance)).toStrictEqual({ IMP_IDLE_TIMEOUT_S: '5' });
});

test('#buildJourneyEnv hands a suite’s own idle timeout to its journeys', () => {
  expect(buildJourneyEnv({ IMP_IDLE_TIMEOUT_S: '5', IMP_KSM: '1' })).toStrictEqual({
    E2E_IDLE_TIMEOUT_S: '5',
  });
});

test('#buildJourneyEnv leaves the run’s idle timeout to a suite that sets none', () => {
  expect(buildJourneyEnv({ IMP_KSM: '1' })).toStrictEqual({});
});

test('#buildJourneyEnv leaves the run’s idle timeout to a suite on the run’s settings', () => {
  expect(buildJourneyEnv(null)).toStrictEqual({});
});

test('#buildKsmSettings keeps the run’s settings on a host without KSM', () => {
  expect(buildKsmSettings(false)).toBeNull();
});

test('#buildKsmSettings puts the instance on KSM, a one-guest budget and no idle sleeps on a host that runs KSM', () => {
  expect(buildKsmSettings(true)).toStrictEqual({
    IMP_KSM: '1',
    IMP_RAM_BUDGET_MIB: '512',
    IMP_BOOT_RESERVE_PERCENT: '20',
    IMP_IDLE_TIMEOUT_S: '600',
  });
});

test('#readSuiteSettings rejects a name that no suite has', () => {
  expect(() => readSuiteSettings('nope', instance)).toThrowWithMessage(
    Error,
    'no suite named nope',
  );
});

test('#SUITES gives every suite at least one journey', () => {
  expect(SUITES).toSatisfyAll((suite: Readonly<Suite>) => listJourneys(suite).length > 0);
});

test('#SUITE_SETS runs scale before restart in the acceptance set', () => {
  const acceptance = SUITE_SETS['acceptance'] ?? [];

  expect(acceptance.indexOf('scale')).toBeGreaterThanOrEqual(0);
  expect(acceptance.indexOf('restart')).toBe(acceptance.indexOf('scale') + 1);
});

test('#SUITES runs every test file in the daemon’s e2e folder exactly once', () => {
  const suitesDir = join(import.meta.dir, '..', '..', 'daemon', 'e2e');

  const files = readdirSync(suitesDir)
    .filter((file) => file.endsWith('.test.ts'))
    .map((file) => file.replace(/^[a-z]+-/v, '').replace(/(?:\.zfs)?\.test\.ts$/v, ''));

  const journeys = SUITES.flatMap((suite) => listJourneys(suite));

  expect(journeys).toIncludeSameMembers(files);
  expect(new Set(journeys).size).toBe(journeys.length);
});

test('#SUITES gives every suite its own e2e- imp name prefix', () => {
  const prefixes = SUITES.map((suite) => suite.prefix);

  expect(new Set(prefixes).size).toBe(SUITES.length);
  expect(prefixes).toSatisfyAll((prefix: string) => prefix.startsWith('e2e-'));
});

test('#SUITE_SETS builds the fast set from the groups, in run order', () => {
  expect(SUITE_SETS['fast']).toStrictEqual([
    'lifecycle',
    'registry',
    'checkpoints',
    'disks',
    'sleep',
    'restart',
    'tailscale',
    'mcp',
    'mcp-oauth',
    'offsets',
    'session-logs',
    'services',
    'ssh',
    'ssh-agent',
    'reverse',
    'proxy',
    'dashboard',
    'tokens',
    'leases',
    'egress',
    'cpu',
    'templates',
    'boot-templates',
    'inner',
    'socket',
    'moves-tailnet',
    'jail',
    'memory',
    'ksm',
    'huge-pages',
  ]);
});

test('#FAST_GROUPS puts no suite in two groups', () => {
  const suites = FAST_GROUPS.flat();

  expect(new Set(suites).size).toBe(suites.length);
});

test('#FAST_GROUPS splits the fast set four ways', () => {
  expect(FAST_GROUPS).toHaveLength(4);
});

test('#FAST_GROUPS keeps the run order inside each group', () => {
  const order = SUITES.map((suite) => suite.name);

  expect(FAST_GROUPS).toSatisfyAll(
    (group: readonly string[]) =>
      order.filter((name) => group.includes(name)).join(',') === group.join(','),
  );
});

test('#FAST_GROUPS leaves scale out, as the fast set does', () => {
  expect(FAST_GROUPS.flat()).not.toContain('scale');
});

test('#HOST_TESTS_GROUP names one of the fast groups', () => {
  expect(HOST_TESTS_GROUP).toBeOneOf([1, 2, 3]);
});

test('#SUITES gives no suite a prefix that a fixture image name starts with', () => {
  const fixtures = ['base', 'e2e-tiny-', 'e2e-bare-', 'e2e-ws-', 'e2e-git-', 'e2e-ra-'];

  expect(SUITES).toSatisfyAll((suite: Readonly<Suite>) =>
    fixtures.every((fixture) => !fixture.startsWith(suite.prefix)),
  );
});

test("#SUITES gives no suite a prefix that starts another suite's prefix", () => {
  const prefixes = SUITES.map((suite) => suite.prefix);

  expect(prefixes).toSatisfyAll((prefix: string) =>
    prefixes.every((other) => other === prefix || !other.startsWith(prefix)),
  );
});

test('#FAST_GROUPS gets one e2e-group job each in ci.yml, with the host tests in the host tests group alone', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);

  expect(workflow).toMatchObject({
    jobs: {
      'e2e-group': {
        strategy: {
          matrix: {
            include: FAST_GROUPS.map((_, index) => ({
              group: index + 1,
              'host-tests': index + 1 === HOST_TESTS_GROUP,
            })),
          },
        },
      },
    },
  });
});

test('#pickZfsShard runs every ZFS lane suite once over the lane shards ci.yml lists', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);
  const rows = findYamlValue(workflow, ['jobs', 'zfs-shard', 'strategy', 'matrix', 'include']);

  invariant(Array.isArray(rows));

  const lanes = rows
    .map((row: unknown) => findYamlValue(row, ['lane']))
    .filter((lane) => typeof lane === 'string');

  const suites = lanes.flatMap((lane) => {
    const [index, count] = lane.split('/').map(Number);

    return pickZfsShard(index ?? 0, count ?? 0);
  });

  expect(lanes).toStrictEqual(
    lanes.map((_, index) => `${String(index + 1)}/${String(lanes.length)}`),
  );

  expect(suites.toSorted()).toStrictEqual(
    listZfsSuites()
      .map((suite) => suite.name)
      .toSorted(),
  );
});

test('#listZfsSuites names no suite that a ZFS backend shard in ci.yml runs', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);
  const rows = findYamlValue(workflow, ['jobs', 'zfs-shard', 'strategy', 'matrix', 'include']);

  invariant(Array.isArray(rows));

  const suites = rows
    .map((row: unknown) => findYamlValue(row, ['suites']))
    .filter((list) => typeof list === 'string')
    .flatMap((list) => list.split(','));

  const lane = new Set(listZfsSuites().map((suite) => suite.name));

  expect(suites).not.toBeEmpty();
  expect(suites.filter((suite) => lane.has(suite))).toStrictEqual([]);
  expect(SUITES.map((suite) => suite.name)).toIncludeAllMembers(suites);
});

test('#pickZfsShard gets a lane share, suites, or both from each zfs shard in ci.yml', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);
  const rows = findYamlValue(workflow, ['jobs', 'zfs-shard', 'strategy', 'matrix', 'include']);

  invariant(Array.isArray(rows));

  expect(rows).toSatisfyAll(
    (row: unknown) =>
      findYamlValue(row, ['lane']) !== undefined || findYamlValue(row, ['suites']) !== undefined,
  );
});
