import { expect, onTestFinished, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStubCalls } from '@zgeoff/testing/bin';
import { buildRecordCall } from './build-record-call';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-record-call-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory, script: join(directory, 'tool.sh') };
}

test('it records the call of a script with its arguments, even when they hold quotes and spaces', () => {
  const ctx = setupTest();

  writeFileSync(
    ctx.script,
    `#!/bin/bash\n${buildRecordCall({ name: 'tool', callsFile: join(ctx.directoryPath, 'calls.jsonl') })}\n`,
  );

  chmodSync(ctx.script, 0o755);

  Bun.spawnSync([ctx.script, String.raw`say "hi" \ there`, 'two words']);

  expect(readStubCalls(ctx.directoryPath)).toStrictEqual([
    {
      name: 'tool',
      argv: [String.raw`say "hi" \ there`, 'two words'],
      cwd: process.cwd(),
      env: {},
      stdin: '',
    },
  ]);
});

test('it records the variables it is given in order, empty when unset', () => {
  const ctx = setupTest();

  const record = buildRecordCall({
    name: 'tool',
    callsFile: join(ctx.directoryPath, 'calls.jsonl'),
    recordEnv: ['JOBS', 'MISSING'],
  });

  writeFileSync(ctx.script, `#!/bin/bash\n${record}\n`);
  chmodSync(ctx.script, 0o755);

  Bun.spawnSync([ctx.script], { env: { JOBS: '5' } });

  expect(readStubCalls(ctx.directoryPath).map((call) => call.env)).toStrictEqual([
    { JOBS: '5', MISSING: '' },
  ]);
});

test('it records the arguments it is told to in place of the script’s own', () => {
  const ctx = setupTest();

  const record = buildRecordCall({
    name: 'unit',
    callsFile: join(ctx.directoryPath, 'calls.jsonl'),
    args: '"$(echo ExecStart=x)"',
  });

  writeFileSync(ctx.script, `#!/bin/bash\n${record}\n`);
  chmodSync(ctx.script, 0o755);

  Bun.spawnSync([ctx.script, 'ignored']);

  const [call] = readStubCalls(ctx.directoryPath);

  expect({ name: call?.name, argv: call?.argv }).toStrictEqual({
    name: 'unit',
    argv: ['ExecStart=x'],
  });
});

test('it records arguments and variables that hold newlines, tabs and carriage returns', () => {
  const ctx = setupTest();

  const record = buildRecordCall({
    name: 'tool',
    callsFile: join(ctx.directoryPath, 'calls.jsonl'),
    recordEnv: ['NOTE'],
  });

  writeFileSync(ctx.script, `#!/bin/bash\n${record}\n`);
  chmodSync(ctx.script, 0o755);

  Bun.spawnSync([ctx.script, 'one\ntwo', 'a\tb\r'], { env: { NOTE: 'x\ny' } });

  const [call] = readStubCalls(ctx.directoryPath);

  expect({ argv: call?.argv, env: call?.env }).toStrictEqual({
    argv: ['one\ntwo', 'a\tb\r'],
    env: { NOTE: 'x\ny' },
  });
});
