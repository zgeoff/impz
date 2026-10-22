import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readMachineID } from './read-machine-id.ts';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-machine-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it reads the machine id without its newline from IMP_MACHINE_ID_FILE', () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'machine-id');

  writeFileSync(file, 'fake-machine-id\n');

  expect(readMachineID({ IMP_MACHINE_ID_FILE: file })).toStrictEqual({
    file,
    id: 'fake-machine-id',
  });
});

test('it reads an empty id when the file is missing', () => {
  const ctx = setupTest();
  const file = join(ctx.directoryPath, 'missing');

  expect(readMachineID({ IMP_MACHINE_ID_FILE: file })).toStrictEqual({ file, id: '' });
});

test('it reads /etc/machine-id without IMP_MACHINE_ID_FILE', () => {
  expect(readMachineID({}).file).toBe('/etc/machine-id');
});
