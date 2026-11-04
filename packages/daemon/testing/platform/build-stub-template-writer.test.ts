import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStubTemplateWriter } from './build-stub-template-writer';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-template-writer-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directory };
}

test('it writes its contents to each path and records the path', async () => {
  const ctx = setupTest();
  const writer = buildStubTemplateWriter({ contents: 'a migrated template' });

  await writer.writeTemplate(join(ctx.directory, 'first.sqlite'));

  expect({
    contents: readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8'),
    builds: writer.builds,
  }).toStrictEqual({
    contents: 'a migrated template',
    builds: [join(ctx.directory, 'first.sqlite')],
  });
});

test('it holds the partial contents until the release settles', () => {
  const release = Promise.withResolvers<void>();
  const writes: Promise<void>[] = [];

  // registered before the folder's removal, so the paused write ends first
  onTestFinished(async () => {
    release.resolve();

    await Promise.all(writes);
  });

  const ctx = setupTest();

  const writer = buildStubTemplateWriter({
    contents: 'a migrated template',
    pause: { partial: 'half a template', release: release.promise },
  });

  writes.push(writer.writeTemplate(join(ctx.directory, 'first.sqlite')));

  expect(readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8')).toBe('half a template');
});

test('it writes its contents once the release settles', async () => {
  const ctx = setupTest();

  const writer = buildStubTemplateWriter({
    contents: 'a migrated template',
    pause: { partial: 'half a template', release: Promise.resolve() },
  });

  await writer.writeTemplate(join(ctx.directory, 'first.sqlite'));

  expect(readFileSync(join(ctx.directory, 'first.sqlite'), 'utf8')).toBe('a migrated template');
});

test('it rejects with its failure after it writes its contents', () => {
  const ctx = setupTest();

  const writer = buildStubTemplateWriter({
    contents: 'half a template',
    failure: new Error('the disk went away'),
  });

  expect(writer.writeTemplate(join(ctx.directory, 'first.sqlite'))).rejects.toThrow(
    'the disk went away',
  );
});
