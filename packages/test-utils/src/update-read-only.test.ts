import { expect, onTestFinished, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeUpdateReadOnly } from './probe-update-read-only';
import { updateReadOnly } from './update-read-only';

function setupTest() {
  const stack = new DisposableStack();

  onTestFinished(() => {
    stack.dispose();
  });

  const directory = mkdtempSync(join(tmpdir(), 'update-read-only-'));

  stack.defer(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { stack, directoryPath: directory };
}

test.skipIf(!probeUpdateReadOnly())('it refuses a new file anywhere in the tree', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'tree', 'inner'), { recursive: true });
  updateReadOnly(ctx.stack, join(ctx.directoryPath, 'tree'));

  expect(() => {
    writeFileSync(join(ctx.directoryPath, 'tree', 'inner', 'new'), 'x');
  }).toThrow(expect.objectContaining({ code: expect.toBeOneOf(['EACCES', 'EPERM']) }));
});

test.skipIf(!probeUpdateReadOnly())('it keeps a symlink in the tree from going', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'tree'));
  writeFileSync(join(ctx.directoryPath, 'target'), 'x');
  symlinkSync(join(ctx.directoryPath, 'target'), join(ctx.directoryPath, 'tree', 'link'));
  updateReadOnly(ctx.stack, join(ctx.directoryPath, 'tree'));

  expect(() => {
    unlinkSync(join(ctx.directoryPath, 'tree', 'link'));
  }).toThrow(expect.objectContaining({ code: expect.toBeOneOf(['EACCES', 'EPERM']) }));
});

test.skipIf(!probeUpdateReadOnly())('it keeps the files in the tree readable', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'tree'));
  writeFileSync(join(ctx.directoryPath, 'tree', 'kept'), 'kept\n');
  updateReadOnly(ctx.stack, join(ctx.directoryPath, 'tree'));

  expect(readFileSync(join(ctx.directoryPath, 'tree', 'kept'), 'utf8')).toBe('kept\n');
});

test.skipIf(!probeUpdateReadOnly())('it makes the tree writable again on restore', () => {
  const ctx = setupTest();

  mkdirSync(join(ctx.directoryPath, 'tree'));

  const restore = updateReadOnly(ctx.stack, join(ctx.directoryPath, 'tree'));

  restore();
  writeFileSync(join(ctx.directoryPath, 'tree', 'new'), 'x');

  expect(readFileSync(join(ctx.directoryPath, 'tree', 'new'), 'utf8')).toBe('x');
});

test.skipIf(!probeUpdateReadOnly())(
  'it makes the tree writable again when the stack is released',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'tree'));

    const stack = new DisposableStack();

    // released by the test's own stack too, before the directory goes, should
    // the test fail first
    ctx.stack.defer(() => {
      stack.dispose();
    });

    updateReadOnly(stack, join(ctx.directoryPath, 'tree'));

    stack.dispose();

    writeFileSync(join(ctx.directoryPath, 'tree', 'new'), 'x');

    expect(readFileSync(join(ctx.directoryPath, 'tree', 'new'), 'utf8')).toBe('x');
  },
);

test.skipIf(!probeUpdateReadOnly())(
  'it passes over a tree removed before the stack is released',
  () => {
    const ctx = setupTest();

    mkdirSync(join(ctx.directoryPath, 'tree'));

    const stack = new DisposableStack();

    const restore = updateReadOnly(stack, join(ctx.directoryPath, 'tree'));

    restore();
    rmSync(join(ctx.directoryPath, 'tree'), { recursive: true });

    expect(() => {
      stack.dispose();
    }).not.toThrow();
  },
);
