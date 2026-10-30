import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-zfs-summary-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  writeFileSync(join(directory, 'step-summary'), '');

  return {
    zfsDir: directory,
    stepSummary: join(directory, 'step-summary'),
    scriptPath: join(import.meta.dir, 'write-zfs-summary.ts'),
  };
}

test("it adds the zfs host test's timings to the job summary, in a text block", async () => {
  const ctx = setupTest();

  writeFileSync(join(ctx.zfsDir, 'summary.txt'), 'create pool  1.2 s\nboot imp     4.0 s\n');

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, IMP_ZFS_TEST_DIR: ctx.zfsDir, GITHUB_STEP_SUMMARY: ctx.stepSummary })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.stepSummary, 'utf8')).toBe(
    [
      'Nested KVM on a shared runner, a pool in a sparse file and a 1 GiB ARC: these',
      'numbers do not compare directly with XFS ones.',
      '',
      '```text',
      'create pool  1.2 s',
      'boot imp     4.0 s',
      '```',
      '',
    ].join('\n'),
  );
});

test('it says so in the job summary when the run stopped before it picked a work dir', async () => {
  const ctx = setupTest();
  const { IMP_ZFS_TEST_DIR: _, ...env } = process.env;

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...env, GITHUB_STEP_SUMMARY: ctx.stepSummary })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.stepSummary, 'utf8')).toInclude(
    '```text\nno summary: the run stopped before it\n```\n',
  );
});

test('it says so in the job summary when the run stopped before its summary', async () => {
  const ctx = setupTest();

  const result = await $`bun ${ctx.scriptPath}`
    .env({ ...process.env, IMP_ZFS_TEST_DIR: ctx.zfsDir, GITHUB_STEP_SUMMARY: ctx.stepSummary })
    .nothrow()
    .quiet();

  expect(result.exitCode).toBe(0);

  expect(readFileSync(ctx.stepSummary, 'utf8')).toInclude(
    '```text\nno summary: the run stopped before it\n```\n',
  );
});
