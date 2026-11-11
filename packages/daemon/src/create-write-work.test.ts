import { expect, test } from 'bun:test';
import { createWriteWork } from './create-write-work';
import { captureImpdLogs } from './test-utils/platform/capture-impd-logs';

test('it logs work that rejects instead of leaving the rejection unhandled', async () => {
  const logs = captureImpdLogs();
  const writeWork = createWriteWork();

  writeWork.run(Promise.reject(new Error('driver has already been destroyed')));

  await writeWork.stop();

  expect(logs).toStrictEqual([
    'WARNING impd.events could not follow a database write: driver has already been destroyed',
  ]);
});
