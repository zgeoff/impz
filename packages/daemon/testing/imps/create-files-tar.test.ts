import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesTar } from './create-files-tar';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'files-tar-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test('it lists each file by its name', async () => {
  const ctx = await setupTest();

  const tar = createFilesTar(ctx.directoryPath, { hello: 'hi\n', other: 'there\n' });
  const listed = Bun.spawnSync(['tar', '-t', '-f', '-'], { stdin: tar }).stdout.toString();

  expect(listed).toBe('hello\nother\n');
});

test('it holds the content of each file', async () => {
  const ctx = await setupTest();

  const tar = createFilesTar(ctx.directoryPath, { hello: 'hi\n' });
  const content = Bun.spawnSync(['tar', '-x', '-O', '-f', '-', 'hello'], { stdin: tar }).stdout;

  expect(content.toString()).toBe('hi\n');
});

test('it writes each tree in a fresh directory, so the same name twice does not clash', async () => {
  const ctx = await setupTest();

  createFilesTar(ctx.directoryPath, { hello: 'one\n' });

  const tar = createFilesTar(ctx.directoryPath, { hello: 'two\n' });
  const content = Bun.spawnSync(['tar', '-x', '-O', '-f', '-', 'hello'], { stdin: tar }).stdout;

  expect(content.toString()).toBe('two\n');
});

// a name tar reads as an option of its own, which it refuses
test('it throws with tar exit code and stderr when tar fails', async () => {
  const ctx = await setupTest();

  expect(() => createFilesTar(ctx.directoryPath, { '--no-such-option': 'x\n' })).toThrowWithMessage(
    Error,
    /^tar exited 64: tar: unrecognized option '--no-such-option'/v,
  );
});
