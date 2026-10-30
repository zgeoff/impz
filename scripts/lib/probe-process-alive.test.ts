import { expect, test } from 'bun:test';
import { probeProcessAlive } from './probe-process-alive';

test('it finds the running process alive', () => {
  expect(probeProcessAlive(process.pid)).toBe(true);
});

test('it finds a process that has exited not alive', async () => {
  const gone = Bun.spawn(['true']);

  await gone.exited;

  expect(probeProcessAlive(gone.pid)).toBe(false);
});

// init runs as root, so a user other than root gets EPERM for it
test('it finds a live process of another user alive', () => {
  expect(probeProcessAlive(1)).toBe(true);
});
