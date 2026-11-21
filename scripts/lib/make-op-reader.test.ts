import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatStubCalls } from '@impz/shared/test-utils/format-stub-calls';
import { createStubBin, readStubCalls } from '@zgeoff/testing/bin';
import invariant from 'tiny-invariant';
import { makeOpReader } from './make-op-reader.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-op-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it reads a secret with op read, without its newline', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'op', { script: "#!/bin/bash\necho 'fake-secret'" });

  const readOp = makeOpReader({ PATH: ctx.directoryPath });

  invariant(readOp);

  const secret = await readOp('op://example/item/field');

  expect(secret).toBe('fake-secret');

  expect(formatStubCalls(readStubCalls(ctx.directoryPath))).toBe(
    'op read op://example/item/field\n',
  );
});

test('it reads an empty secret when op read fails', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'op', {
    script: "#!/bin/bash\necho 'partial'; exit 1",
  });

  const readOp = makeOpReader({ PATH: ctx.directoryPath });

  invariant(readOp);

  const secret = await readOp('op://example/item/field');

  expect(secret).toBe('');
});

test('it closes op stdin, so a prompt cannot hang the run', async () => {
  const ctx = setupTest();

  createStubBin(ctx.directoryPath, 'op', {
    script: '#!/bin/bash\nread -r line && echo "got $line"',
  });

  const readOp = makeOpReader({ PATH: ctx.directoryPath });

  invariant(readOp);

  const secret = await readOp('op://example/item/field');

  expect(secret).toBe('');
});

test('it gives no reader when op is not on PATH', () => {
  const ctx = setupTest();

  expect(makeOpReader({ PATH: ctx.directoryPath })).toBeNull();
});
