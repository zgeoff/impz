import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
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

test('it refuses a tee to a path it is told to refuse, after recording what it read', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath, { refusedTees: ['/proc/sys/vm/nr_hugepages'] });

  const result = Bun.spawnSync(['sudo', 'tee', '/proc/sys/vm/nr_hugepages'], {
    env: { PATH: sudo.bin },
    stdin: Buffer.from('512\n'),
  });

  expect(result.exitCode).toBe(1);
  expect(readFileSync(sudo.calls, 'utf8')).toBe('sudo tee /proc/sys/vm/nr_hugepages\n< 512\n');
});

test('it passes a tee to any other path', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath, { refusedTees: ['/proc/sys/vm/nr_hugepages'] });

  const result = Bun.spawnSync(['sudo', 'tee', '/sys/kernel/mm/ksm/run'], {
    env: { PATH: sudo.bin },
    stdin: Buffer.from('1\n'),
  });

  expect(result.exitCode).toBe(0);
});

test('it hands a command it runs on to the stand-in of that name, and answers with its exit code', () => {
  const ctx = setupTest();
  const sudo = createStubSudo(ctx.directoryPath, { runs: ['apt-get'] });

  createStubBin(ctx.directoryPath, 'apt-get', 'exit 7');

  const result = Bun.spawnSync(['sudo', 'apt-get', 'update'], { env: { PATH: sudo.bin } });

  expect(result.exitCode).toBe(7);
  expect(readFileSync(sudo.calls, 'utf8')).toBe('sudo apt-get update\napt-get update\n');
});
