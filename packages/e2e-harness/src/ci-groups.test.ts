// oxlint-disable-next-line zgeoff/test-beside-module -- it tests .github/workflows/ci.yml, and bun test never searches .github/ for a test beside it
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseCiWorkflow } from '../../../scripts/test-utils/parse-ci-workflow';
import { readLongestPullRequestTimeout } from '../../../scripts/test-utils/read-longest-pull-request-timeout';
import { FAST_GROUPS, HOST_TESTS_GROUP, SUITES, listZfsSuites, pickZfsShard } from './suites';

test('it runs one e2e-group job for each fast group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const groups = jobs['e2e-group'].strategy.matrix.include.map((row) => row.group);

  expect(groups).toStrictEqual(FAST_GROUPS.map((_, index) => index + 1));
});

test('it runs the host networking tests only in the host tests group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const hostGroups = jobs['e2e-group'].strategy.matrix.include
    .filter((row) => row['host-tests'])
    .map((row) => row.group);

  expect(hostGroups).toStrictEqual([HOST_TESTS_GROUP]);
});

test('it gates the host networking step on the matrix flag', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find(
    (candidate) => candidate.name === 'Host networking tests',
  );

  expect(step?.if).toBe('matrix.host-tests');
});

test('it installs the browser only in the group that runs the dashboard suite', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const browserGroups = jobs['e2e-group'].strategy.matrix.include
    .filter((row) => row.browser)
    .map((row) => row.group);

  expect(browserGroups).toStrictEqual([
    FAST_GROUPS.findIndex((group) => group.includes('dashboard')) + 1,
  ]);
});

test('it runs each group with its own --group flag', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find((candidate) => candidate.name === 'End-to-end tests');

  // an Actions expression, not a template placeholder
  expect(step?.run).toBe(`e2e/test-e2e.sh --group \${{ matrix.group }}`);
});

test('it runs the required e2e check whatever the groups did', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.e2e.if).toBe('always()');
});

test('it makes the required e2e check wait on every group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.e2e.needs).toStrictEqual(['e2e-group']);
});

test('it passes the required e2e check only when the groups succeeded', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const runs = jobs.e2e.steps.map((step) => step.run);

  expect(runs.join('\n')).toInclude('test "$RESULT" = success');
});

test('it calls the shared release job at the sync tag that repo-sync calls', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const repoSync = readFileSync(
    new URL('../../../.github/workflows/repo-sync.yml', import.meta.url),
    'utf8',
  );

  const syncTag = /zgeoff\/tools\/\.github\/workflows\/repo-sync\.yml@(?<tag>\S+)/u.exec(repoSync)
    ?.groups?.['tag'];

  expect(syncTag).toBeString();
  expect(jobs.release.uses).toBe(`zgeoff/tools/.github/workflows/release-please.yml@${syncTag}`);
});

test("it waits for the release PR's checks longer than any pull request job may run", () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const longest = readLongestPullRequestTimeout(
    new URL('../../../.github/workflows', import.meta.url).pathname,
  );

  expect(jobs.release.with['checks-timeout-minutes']).toBeGreaterThan(longest);
});

test('it writes the build caches from group 1 alone, and only on a push', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs['e2e-group'].env.WRITE_CACHE).toBe(
    `\${{ github.event_name == 'push' && matrix.group == 1 }}`,
  );
});

test.each([['Read the Playwright version'], ['Cache Playwright Browsers']])(
  'it gates the %s step on the matrix browser flag',
  (name) => {
    const jobs = parseCiWorkflow(
      readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
    );

    const step = jobs['e2e-group'].steps.find((candidate) => candidate.name === name);

    expect(step?.if).toBe('matrix.browser');
  },
);

test('it names each group its own results artifact', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find((candidate) => candidate.name === 'Upload results');
  const groups = jobs['e2e-group'].strategy.matrix.include.map((row) => row.group);

  const names = groups.map((group) =>
    (step?.with?.name ?? '').replaceAll(`\${{ matrix.group }}`, String(group)),
  );

  expect(new Set(names).size).toBe(groups.length);
});

test('it binds the required e2e check to the result of every group', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs.e2e.steps.find((candidate) => candidate.run?.includes('$RESULT') === true);

  expect(step?.env?.['RESULT']).toBe(`\${{ needs.e2e-group.result }}`);
});

test('it never lets the required e2e check swallow a failure', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const runs = jobs.e2e.steps.map((step) => step.run ?? '').join('\n');

  expect(runs).not.toInclude('|| true');
});

test('it lets every group finish, so one failure does not hide another', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs['e2e-group'].strategy['fail-fast']).toBeFalse();
});

test('it hands the cache writer flag to the build inputs step', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['e2e-group'].steps.find(
    (candidate) => candidate.name === 'Build kernel, system drive and host image',
  );

  expect(step?.with?.['write-cache']).toBe(`\${{ env.WRITE_CACHE }}`);
});

test('it runs exactly the result check in the required e2e step', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs.e2e.steps.find(
    (candidate) => candidate.name === 'Require every e2e group to pass',
  );

  expect(step?.run).toBe('echo "e2e groups: $RESULT"\ntest "$RESULT" = success\n');
});

test('it runs the required zfs check whatever the shards did', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.zfs.if).toBe('always()');
});

test('it makes the required zfs check wait on every shard', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs.zfs.needs).toStrictEqual(['zfs-shard']);
});

test('it passes the required zfs check only when the shards succeeded', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs.zfs.steps.find(
    (candidate) => candidate.name === 'Require every zfs shard to pass',
  );

  expect(step?.env?.['RESULT']).toBe(`\${{ needs.zfs-shard.result }}`);
  expect(step?.run).toBe('echo "zfs shards: $RESULT"\ntest "$RESULT" = success\n');
});

test('it lets every zfs shard finish, so one failure does not hide another', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs['zfs-shard'].strategy['fail-fast']).toBeFalse();
});

test('it runs the ZFS lane over the lane shards, so every *.zfs.e2e.ts suite runs once', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const lanes = jobs['zfs-shard'].strategy.matrix.include.flatMap((row) =>
    row.lane === undefined ? [] : [row.lane],
  );

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

test('it runs only VM e2e suites in the ZFS backend shard, never a ZFS lane suite', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const suites = jobs['zfs-shard'].strategy.matrix.include.flatMap((row) =>
    row.suites === undefined ? [] : row.suites.split(','),
  );

  const lane = new Set(listZfsSuites().map((suite) => suite.name));

  expect(suites).not.toBeEmpty();
  expect(suites.filter((suite) => lane.has(suite))).toStrictEqual([]);
  expect(SUITES.map((suite) => suite.name)).toIncludeAllMembers(suites);
});

test('it gives each zfs shard a lane share, its suites, or both', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const idle = jobs['zfs-shard'].strategy.matrix.include.filter(
    (row) => row.lane === undefined && row.suites === undefined,
  );

  expect(idle).toStrictEqual([]);
});

test('it hands each zfs shard its own lane share and suites', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  expect(jobs['zfs-shard'].env).toMatchObject({
    IMP_ZFS_SHARD: `\${{ matrix.lane }}`,
    IMP_ZFS_E2E_SUITES: `\${{ matrix.suites }}`,
  });
});

test('it runs the ZFS backend tests in one shard only', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['zfs-shard'].steps.find((candidate) => candidate.name === 'ZFS backend tests');
  const unitShards = jobs['zfs-shard'].strategy.matrix.include.filter((row) => row.unit);

  expect(step?.if).toBe('matrix.unit');
  expect(unitShards).toHaveLength(1);
});

test('it names each zfs shard its own results artifact', () => {
  const jobs = parseCiWorkflow(
    readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'),
  );

  const step = jobs['zfs-shard'].steps.find((candidate) => candidate.name === 'Upload results');
  const shards = jobs['zfs-shard'].strategy.matrix.include.map((row) => row.shard);

  const names = shards.map((shard) =>
    (step?.with?.name ?? '').replaceAll(`\${{ matrix.shard }}`, String(shard)),
  );

  expect(new Set(names).size).toBe(shards.length);
});
