// oxlint-disable-next-line zgeoff/test-beside-module -- it tests .github/workflows/ci.yml, and bun test never searches .github/ for a test beside it
import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { findYamlValue } from '../../../scripts/test-utils/find-yaml-value';
import { readLongestPullRequestTimeout } from '../../../scripts/test-utils/read-longest-pull-request-timeout';
import { FAST_GROUPS, HOST_TESTS_GROUP, SUITES, listZfsSuites, pickZfsShard } from './suites';

test('it runs one e2e-group job for each fast group, with the host tests in the host tests group alone', async () => {
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

test('it calls the shared release job and the workflow lint at the sync tag that repo-sync calls', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);

  const repoSyncText = await Bun.file(
    new URL('../../../.github/workflows/repo-sync.yml', import.meta.url),
  ).text();

  const repoSync = Bun.YAML.parse(repoSyncText);

  const syncTag = /@(?<tag>\S+)$/u.exec(String(findYamlValue(repoSync, ['jobs', 'sync', 'uses'])))
    ?.groups?.['tag'];

  invariant(syncTag !== undefined);

  expect(workflow).toMatchObject({
    jobs: {
      release: { uses: `zgeoff/tools/.github/workflows/release-please.yml@${syncTag}` },
      shellcheck: { env: { WORKFLOW_LINT_REF: syncTag } },
    },
  });
});

test("it waits for the release PR's checks longer than any pull request job may run", async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);

  const longest = readLongestPullRequestTimeout(
    new URL('../../../.github/workflows', import.meta.url).pathname,
  );

  expect(
    findYamlValue(workflow, ['jobs', 'release', 'with', 'checks-timeout-minutes']),
  ).toBeGreaterThan(longest);
});

test('it runs the ZFS lane over the lane shards, so every *.zfs.e2e.ts suite runs once', async () => {
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

test('it runs only VM e2e suites in the ZFS backend shards, never a ZFS lane suite', async () => {
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

test('it gives each zfs shard a lane share, its suites, or both', async () => {
  const text = await Bun.file(new URL('../../../.github/workflows/ci.yml', import.meta.url)).text();

  const workflow = Bun.YAML.parse(text);
  const rows = findYamlValue(workflow, ['jobs', 'zfs-shard', 'strategy', 'matrix', 'include']);

  invariant(Array.isArray(rows));

  expect(rows).toSatisfyAll(
    (row: unknown) =>
      findYamlValue(row, ['lane']) !== undefined || findYamlValue(row, ['suites']) !== undefined,
  );
});
