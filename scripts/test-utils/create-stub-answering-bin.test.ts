import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { readStubCalls } from '@zgeoff/testing/bin';
import { createStubAnsweringBin } from './create-stub-answering-bin';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-answering-bin-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it answers a call with the first answer whose args start the call', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['network', 'create'], exitCode: 1, stderr: 'pool overlaps' },
    { args: ['network'], exitCode: 0, stdout: 'later answer' },
  ]);

  const result = Bun.spawnSync([
    join(ctx.directoryPath, 'docker'),
    'network',
    'create',
    'lane-net',
  ]);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }).toStrictEqual({ exitCode: 1, stdout: '', stderr: 'pool overlaps' });
});

test('it prints nothing and exits 0 for a call no answer matches, and logs every call', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['pull'], exitCode: 1, stderr: 'toomanyrequests' },
  ]);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'docker'), 'start', 'lane-box']);

  expect({
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    calls: formatStubCalls(readStubCalls(ctx.directoryPath)),
  }).toStrictEqual({ exitCode: 0, stdout: '', calls: 'docker start lane-box\n' });
});

test('it matches an argument with a space or a quote in it whole', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'ruby', [
    { args: ['-c', "it's here.rb"], exitCode: 0, stdout: 'Syntax OK\n' },
  ]);

  const matched = Bun.spawnSync([join(ctx.directoryPath, 'ruby'), '-c', "it's here.rb"]);
  const missed = Bun.spawnSync([join(ctx.directoryPath, 'ruby'), '-c', 'it']);

  expect([matched.stdout.toString(), missed.stdout.toString()]).toStrictEqual(['Syntax OK\n', '']);
});

test('it skips an answer whose args outnumber the call, even when the missing one is empty', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'docker', [
    { args: ['pull', ''], exitCode: 1, stderr: 'matched an argument the call lacks' },
  ]);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'docker'), 'pull']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 0,
    stderr: '',
  });
});

test('it matches an empty argument that the call passes', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'challtestsrv', [
    { args: ['-defaultIPv6', ''], exitCode: 0, stdout: 'no IPv6\n' },
  ]);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'challtestsrv'), '-defaultIPv6', '']);

  expect(result.stdout.toString()).toBe('no IPv6\n');
});

test.each([['!'], ['='], ['-n'], ['(']])(
  'it compares an argument that looks like a test operator, %s, as text',
  (arg) => {
    const ctx = setupTest();

    createStubAnsweringBin(ctx.directoryPath, 'tool', [
      { args: [arg], exitCode: 0, stdout: 'matched\n' },
    ]);

    const matched = Bun.spawnSync([join(ctx.directoryPath, 'tool'), arg]);
    const missed = Bun.spawnSync([join(ctx.directoryPath, 'tool'), 'other']);

    expect([matched.stdout.toString(), missed.stdout.toString()]).toStrictEqual(['matched\n', '']);
  },
);

test('it matches an argument past the ninth', () => {
  const ctx = setupTest();
  const args = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'tenth'];

  createStubAnsweringBin(ctx.directoryPath, 'tool', [{ args, exitCode: 0, stdout: 'matched\n' }]);

  const matched = Bun.spawnSync([join(ctx.directoryPath, 'tool'), ...args]);
  const missed = Bun.spawnSync([join(ctx.directoryPath, 'tool'), ...args.slice(0, 9), 'other']);

  expect([matched.stdout.toString(), missed.stdout.toString()]).toStrictEqual(['matched\n', '']);
});

test('it prints stdout and stderr byte for byte, quotes, percent signs and newlines included', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'tool', [
    { args: [], exitCode: 0, stdout: `it's "100%"\n$HOME\n`, stderr: "can't\n\\n" },
  ]);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'tool')]);

  expect({ stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toStrictEqual({
    stdout: `it's "100%"\n$HOME\n`,
    stderr: "can't\n\\n",
  });
});

test('it answers every call with an answer of no args', () => {
  const ctx = setupTest();

  createStubAnsweringBin(ctx.directoryPath, 'bash', [
    { args: [], exitCode: 1, stderr: 'build-formula: no sha256' },
  ]);

  const result = Bun.spawnSync([join(ctx.directoryPath, 'bash'), 'build-formula.sh', '1.2.3']);

  expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toStrictEqual({
    exitCode: 1,
    stderr: 'build-formula: no sha256',
  });
});
