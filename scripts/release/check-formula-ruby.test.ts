import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { createStubAnsweringBin } from '../test-utils/create-stub-answering-bin';

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

  const stub = createStubAnsweringBin(ctx.directoryPath, 'ruby', [
    { args: ['-c'], exitCode: 0, stdout: 'Syntax OK\n' },
  ]);

  const result = await ctx.runScript(stub.bin);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    calls: readFileSync(stub.calls, 'utf8'),
  }).toStrictEqual({
    exitCode: 0,
    stdout: 'formula: Syntax OK\n',
    calls: expect.stringMatching(/^ruby -c \S+\/imp\.rb\n$/v),
  });
});

test('it fails with the build diagnostic, and runs no ruby, when build-formula.sh fails', async () => {
  const ctx = setupTest();

  const stub = createStubAnsweringBin(ctx.directoryPath, 'bash', [
    { args: [], exitCode: 1, stderr: 'build-formula: no sha256 for impz-linux-x64\n' },
  ]);

  createStubAnsweringBin(ctx.directoryPath, 'ruby', [
    { args: ['-c'], exitCode: 0, stdout: 'Syntax OK\n' },
  ]);

  const result = await ctx.runScript(stub.bin);

  expect({
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    rubyCalls: readFileSync(stub.calls, 'utf8')
      .split('\n')
      .filter((call) => call.startsWith('ruby')),
  }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining('build-formula: no sha256 for impz-linux-x64'),
    rubyCalls: [],
  });
});

test('it fails with what ruby printed when ruby refuses the formula', async () => {
  const ctx = setupTest();

  const stub = createStubAnsweringBin(ctx.directoryPath, 'ruby', [
    { args: ['-c'], exitCode: 1, stderr: 'imp.rb:3: syntax error, unexpected end-of-input\n' },
  ]);

  const result = await ctx.runScript(stub.bin);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: expect.stringContaining(
      'ruby -c refused the formula: imp.rb:3: syntax error, unexpected end-of-input',
    ),
  });
});
