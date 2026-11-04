import { expect, test } from 'bun:test';
import { collectReleaseJobProblems, parseSyncRef } from './check-release-jobs';

test('it passes a release job with no gate and a start-release job on its outputs', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual([]);
});

test('it reports a release job that waits on other jobs', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    needs: [checks]',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual(['the release job waits on other jobs, so the tag can land after main moves on']);
});

test('it reports a start-release job that does not wait on the release job', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual(['the start-release job does not wait on the release job']);
});

test('it reports a start-release job that runs on something other than releases_created', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.result == 'success'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual([
    `the start-release job does not run on the release job's releases_created output`,
  ]);
});

test('it reports a start-release job that starts no release.yml run', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - run: echo released',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual(['the start-release job starts no release.yml run']);
});

test('it reports a start-release job that passes another tag', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ github.ref_name }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual([`the start-release job does not pass the release job's tag output as TAG`]);
});

test('it reports a workflow without the start-release job', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '    with:',
    '      checks-timeout-minutes: 60',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual([
    expect.stringMatching(/^the workflow lacks the release jobs: .*start-release/su),
  ]);
});

test('it reports a release job that calls another ref than repo-sync', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v0',
    '    with:',
    '      checks-timeout-minutes: 60',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(
    collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 30 }),
  ).toStrictEqual([
    'the release job does not call the shared release-please.yml at sync-v1, the ref repo-sync calls',
  ]);
});

test.each([30, 45])(
  'it reports a release job that waits %p minutes for checks a pull request job may run for 45',
  (checksTimeoutMinutes) => {
    const yaml = [
      'jobs:',
      '  release:',
      '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
      '    with:',
      `      checks-timeout-minutes: ${String(checksTimeoutMinutes)}`,
      '  start-release:',
      '    needs: [release]',
      "    if: needs.release.outputs.releases_created == 'true'",
      '    steps:',
      '      - env:',
      `          TAG: \${{ needs.release.outputs.tag }}`,
      '        run: gh workflow run release.yml -f tag="$TAG"',
    ].join('\n');

    expect(
      collectReleaseJobProblems(yaml, { syncRef: 'sync-v1', longestPullRequestTimeoutMinutes: 45 }),
    ).toStrictEqual([
      "the release job waits no longer for the release PR's checks than a pull request job may run (45 minutes)",
    ]);
  },
);

test('#parseSyncRef reads the zgeoff/tools ref the sync job calls', () => {
  const yaml = [
    'jobs:',
    '  sync:',
    '    uses: zgeoff/tools/.github/workflows/repo-sync.yml@sync-v1 # main',
  ].join('\n');

  expect(parseSyncRef(yaml)).toBe('sync-v1');
});

test('#parseSyncRef returns null for a workflow with no sync job', () => {
  expect(parseSyncRef('jobs: {}')).toBeNull();
});
