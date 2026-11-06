import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLongestPullRequestTimeout } from './read-longest-pull-request-timeout';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-pull-request-timeout-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it reads the longest job timeout of the workflows a pull request runs', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'checks.yml'),
    [
      'on:',
      '  pull_request:',
      'jobs:',
      '  lint:',
      '    timeout-minutes: 5',
      '  boot:',
      '    timeout-minutes: 30',
    ].join('\n'),
  );

  writeFileSync(
    join(ctx.directory, 'images.yaml'),
    ['on: [push, pull_request]', 'jobs:', '  build:', '    timeout-minutes: 25'].join('\n'),
  );

  expect(readLongestPullRequestTimeout(ctx.directory)).toBe(30);
});

test('it leaves out a workflow that a pull request does not run', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'checks.yml'),
    ['on: pull_request', 'jobs:', '  lint:', '    timeout-minutes: 5'].join('\n'),
  );

  writeFileSync(
    join(ctx.directory, 'publish.yml'),
    ['on:', '  workflow_dispatch:', 'jobs:', '  ship:', '    timeout-minutes: 90'].join('\n'),
  );

  expect(readLongestPullRequestTimeout(ctx.directory)).toBe(5);
});

test('it reads 0 when no pull request job sets a timeout', () => {
  const ctx = setupTest();

  writeFileSync(
    join(ctx.directory, 'checks.yml'),
    ['on: pull_request', 'jobs:', '  call:', '    uses: ./.github/workflows/shared.yml'].join('\n'),
  );

  writeFileSync(join(ctx.directory, 'notes.md'), '# Notes\n');

  expect(readLongestPullRequestTimeout(ctx.directory)).toBe(0);
});
