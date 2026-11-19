import { expect, test } from 'bun:test';
import { readMoveHosts } from '@impz/e2e-harness/move-hosts';
import { readInfo } from '@impz/e2e-harness/run-imp';

function setupTest() {
  const hosts = readMoveHosts({ tailnet: 'off' });

  return { hosts };
}

test('it runs both hosts on the storage backend the run asked for', async () => {
  const ctx = setupTest();
  const backend = process.env['IMP_STORAGE_BACKEND'] === 'zfs' ? 'zfs' : 'xfs';

  const infoA = await readInfo(ctx.hosts.hostA);
  const infoB = await readInfo(ctx.hosts.hostB);

  expect(infoA.storage.backend).toBe(backend);
  expect(infoB.storage.backend).toBe(backend);
});
