import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStepValues } from './write-step-values';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-step-values-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { outputs: join(directory, 'outputs') };
}

test('it appends one name=value line for each value, after the lines already there', () => {
  const ctx = setupTest();

  writeFileSync(ctx.outputs, 'action=push\n');
  writeStepValues(ctx.outputs, { version: '1.2.3', push_tag: 'dryrun-0123456789ab' });

  expect(readFileSync(ctx.outputs, 'utf8')).toBe(
    'action=push\nversion=1.2.3\npush_tag=dryrun-0123456789ab\n',
  );
});
