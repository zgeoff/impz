import { expect, test } from 'bun:test';
import { collectReleaseJobProblems } from './check-release-jobs';

test('it passes a release job with no gate and a start-release job on its outputs', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([]);
});

test('it reports a release job that waits on other jobs', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    needs: [checks]',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    'the release job waits on other jobs, so the tag can land after main moves on',
  ]);
});

test('it reports a start-release job that does not wait on the release job', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    'the start-release job does not wait on the release job',
  ]);
});

test('it reports a start-release job that runs on something other than releases_created', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.result == 'success'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ needs.release.outputs.tag }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    `the start-release job does not run on the release job's releases_created output`,
  ]);
});

test('it reports a start-release job that starts no release.yml run', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - run: echo released',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    'the start-release job starts no release.yml run',
  ]);
});

test('it reports a start-release job that passes another tag', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
    '  start-release:',
    '    needs: [release]',
    "    if: needs.release.outputs.releases_created == 'true'",
    '    steps:',
    '      - env:',
    `          TAG: \${{ github.ref_name }}`,
    '        run: gh workflow run release.yml -f tag="$TAG"',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    `the start-release job does not pass the release job's tag output as TAG`,
  ]);
});

test('it reports a workflow without the start-release job', () => {
  const yaml = [
    'jobs:',
    '  release:',
    '    uses: zgeoff/tools/.github/workflows/release-please.yml@sync-v1',
  ].join('\n');

  expect(collectReleaseJobProblems(yaml)).toStrictEqual([
    expect.stringMatching(/^the workflow lacks the release jobs: .*start-release/su),
  ]);
});
