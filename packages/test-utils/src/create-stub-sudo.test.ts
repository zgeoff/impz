import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubSudo } from '@impz/test-utils/create-stub-sudo';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-sudo-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it records each line that sudo tee reads after the call', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath);

  const result = Bun.spawnSync(['sudo', 'tee', '-a', '/etc/hosts'], {
    env: { PATH: sudo.bin },
    stdin: Buffer.from('10.0.0.7 cache.test\n10.0.0.8 mirror.test\n'),
  });

  expect(result.exitCode).toBe(0);

  expect(readFileSync(sudo.calls, 'utf8')).toBe(
    'sudo tee -a /etc/hosts\n< 10.0.0.7 cache.test\n< 10.0.0.8 mirror.test\n',
  );
});

test('it records a call to another command without reading its input', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath);

  const result = Bun.spawnSync(['sudo', 'modprobe', 'kvm'], {
    env: { PATH: sudo.bin },
    stdin: Buffer.from('ignored\n'),
  });

  expect(result.exitCode).toBe(0);
  expect(readFileSync(sudo.calls, 'utf8')).toBe('sudo modprobe kvm\n');
});

test('it answers with the exit code of its script', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath, 'exit 4');

  const result = Bun.spawnSync(['sudo', 'tee', '/proc/sys/vm/nr_hugepages'], {
    env: { PATH: sudo.bin },
    stdin: Buffer.from('512\n'),
  });

  expect(result.exitCode).toBe(4);
  expect(readFileSync(sudo.calls, 'utf8')).toBe('sudo tee /proc/sys/vm/nr_hugepages\n< 512\n');
});
