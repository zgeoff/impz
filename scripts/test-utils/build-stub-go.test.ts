import { expect, onTestFinished, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { buildStubGo } from './build-stub-go';

function setupTest() {
  const directory = mkdtempSync(join(tmpdir(), 'imp-stub-go-'));

  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return { directoryPath: directory };
}

test('it answers a call in a listed module with its output and exit code', () => {
  const ctx = setupTest();

  const go = createStubBin(
    ctx.directoryPath,
    'go',
    buildStubGo({ 'host/relay': { stdout: 'relay.go:3:1: unused', exitCode: 3 } }),
  );

  const result = Bun.spawnSync(['go', '-C', 'host/relay', 'vet', './...'], {
    env: { PATH: go.bin },
  });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 3,
    stdout: 'relay.go:3:1: unused\n',
  });
});

test('it passes a call in a module it does not list, with no output', () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go', buildStubGo({ 'host/relay': { exitCode: 3 } }));
  const result = Bun.spawnSync(['go', '-C', 'agent', 'vet', './...'], { env: { PATH: go.bin } });

  expect({ exitCode: result.exitCode, stdout: result.stdout.toString() }).toStrictEqual({
    exitCode: 0,
    stdout: '',
  });
});

test('it passes a call outside any module', () => {
  const ctx = setupTest();
  const go = createStubBin(ctx.directoryPath, 'go', buildStubGo({ 'host/relay': { exitCode: 3 } }));

  expect(Bun.spawnSync(['go', 'version'], { env: { PATH: go.bin } }).exitCode).toBe(0);
});
