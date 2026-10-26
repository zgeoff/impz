import { expect, onTestFinished, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStubBin } from '@impz/test-utils/create-stub-bin';
import { buildReachScript } from './build-reach-script';

async function setupTest() {
  const directory = await mkdtemp(join(tmpdir(), 'reach-'));

  onTestFinished(() => rm(directory, { recursive: true, force: true }));

  return { directoryPath: directory };
}

test.each([
  ['a fetch that succeeds', 'exit 0'],
  [
    'a BusyBox 503',
    "echo 'wget: server returned error: HTTP/1.1 503 Service Unavailable' >&2; exit 1",
  ],
  ['a GNU wget error status', 'exit 8'],
])('it counts %s as reached', async (_label, wget) => {
  const ctx = await setupTest();

  const stub = createStubBin(ctx.directoryPath, 'wget', wget);

  const result = Bun.spawnSync(['sh', '-c', buildReachScript('http://example.com/', 5)], {
    env: { PATH: `${stub.bin}:/usr/bin:/bin` },
  });

  expect(result.exitCode).toBe(0);
});

test.each([
  ['a reset connection', "wget: can't connect to remote host (192.0.2.7): Connection refused"],
  ['a refused name', "wget: bad address 'example.org'"],
])("it counts %s as not reached, and prints wget's error", async (_label, message) => {
  const ctx = await setupTest();

  const stub = createStubBin(ctx.directoryPath, 'wget', `printf '%s\\n' "${message}" >&2; exit 1`);

  const result = Bun.spawnSync(['sh', '-c', buildReachScript('http://example.org/', 5)], {
    env: { PATH: `${stub.bin}:/usr/bin:/bin` },
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe(`${message}\n`);
});
