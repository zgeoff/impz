import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { $ } from 'bun';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-check-formula-ruby-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return {
    directoryPath: directory,
    runScript: (bin: string) =>
      $`${process.execPath} ${join(import.meta.dir, 'check-formula-ruby.ts')}`
        .env({ ...process.env, PATH: `${bin}:${process.env['PATH'] ?? ''}` })
        .nothrow()
        .quiet(),
  };
}

test('it passes a formula that ruby parses, and runs ruby -c on the rendered formula', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'ruby',
    `grep -q '^class Impz < Formula$' "$2" || exit 3\necho 'Syntax OK'`,
  );

  const result = await ctx.runScript(stub.bin);

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: 'formula: Syntax OK\n',
  });

  expect(readFileSync(stub.calls, 'utf8')).toMatch(/^ruby -c \S+\/imp\.rb\n$/v);
});

test('it fails with what ruby printed when ruby refuses the formula', async () => {
  const ctx = setupTest();

  const stub = createStubBin(
    ctx.directoryPath,
    'ruby',
    `echo 'imp.rb:3: syntax error, unexpected end-of-input' >&2\nexit 1`,
  );

  const result = await ctx.runScript(stub.bin);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining(
      'ruby -c refused the formula: imp.rb:3: syntax error, unexpected end-of-input',
    ),
  });
});
