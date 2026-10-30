import { expect, test } from 'bun:test';
import { probeProcessAlive } from './probe-process-alive';

test('it finds the running process alive through the real process signal', () => {
  const isAlive = probeProcessAlive(process.pid, (target, signal) => process.kill(target, signal));

  expect(isAlive).toBe(true);
});

test('it finds a process that has exited not alive through the real process signal', async () => {
  const gone = Bun.spawn(['true']);

  await gone.exited;

  const isAlive = probeProcessAlive(gone.pid, (target, signal) => process.kill(target, signal));

  expect(isAlive).toBe(false);
});

test('it finds a process alive that this user may not signal', () => {
  const isAlive = probeProcessAlive(4242, () => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
  });

  expect(isAlive).toBe(true);
});

test('it finds a process not alive when no process has its pid', () => {
  const isAlive = probeProcessAlive(4242, () => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  });

  expect(isAlive).toBe(false);
});
