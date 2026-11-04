import { expect, test } from 'bun:test';
import { probeProcessRunning } from './probe-process-running';

test('it reports the test process as running', () => {
  expect(probeProcessRunning(process.pid)).toBeTrue();
});

test('it reports a process that exited as gone', async () => {
  const exited = Bun.spawn(['true']);

  await exited.exited;

  expect(probeProcessRunning(exited.pid)).toBeFalse();
});
