import { expect, mock, test } from 'bun:test';
import { captureImpdLogs } from '../../../../testing/platform/capture-impd-logs';
import { createZfsReclaim } from './create-zfs-reclaim';
import { createZfsCommands } from './zfs-commands';

test('it stops a reclaim pass after 1000 steps and logs it', async () => {
  const reclaim = createZfsReclaim({
    zfs: createZfsCommands(() => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })),
    datasets: { staging: 'tank/imp/staging', retired: 'tank/imp/retired' },
    runSerial: (task) => task(),
    listAll: () => Promise.resolve([]),
    isKernelOopsed: () => false,
  });

  const runStep = mock(() => Promise.resolve(false));
  const lines = captureImpdLogs();

  await reclaim.runReclaim(runStep);

  expect(runStep).toHaveBeenCalledTimes(1000);
  expect(lines).toStrictEqual(['INFO impd.zfs reclaim stopped after 1000 steps']);
});
