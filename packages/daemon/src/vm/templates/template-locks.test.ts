import { expect, mock, test } from 'bun:test';
import { captureImpdLogs } from '../../../testing/platform/capture-impd-logs';
import { getImpdLogger } from '../../platform/process/get-impd-logger';
import type { MemoryLockResult } from './create-memory-lock';
import { createTemplateLocks } from './template-locks';

test('it counts the memory of a lock still in progress', async () => {
  const sized = Promise.withResolvers<void>();

  const locks = createTemplateLocks({
    lockMemory: (_memFile, onSized) => {
      onSized(2 * 1024 * 1024);

      sized.resolve();

      return new Promise<MemoryLockResult>(() => {});
    },
    probeCurrent: () => true,
    logger: getImpdLogger('boot'),
  });

  void locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });

  await sized.promise;

  expect(locks.readLockedMib()).toBe(2);
});

test('it locks a second build of a key while the first build is still locking', async () => {
  const pending = Promise.withResolvers<MemoryLockResult>();
  const lockMemory = mock(() => pending.promise);

  const locks = createTemplateLocks({
    lockMemory,
    probeCurrent: () => true,
    logger: getImpdLogger('boot'),
  });

  const first = locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });
  const second = locks.lock({ key: 'k1', buildId: 'b2', memFile: '/data/templates/k1/mem' });

  pending.resolve({ errno: 12 });

  await Promise.all([first, second]);

  expect(lockMemory).toHaveBeenCalledTimes(2);
});

test('it logs the errno of a lock that fails through the logger it is given', async () => {
  const logs = captureImpdLogs();

  const locks = createTemplateLocks({
    lockMemory: () => Promise.resolve({ errno: 12 }),
    probeCurrent: () => true,
    logger: getImpdLogger('boot'),
  });

  await locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });

  expect(logs.at(-1)).toInclude('boot template k1 memory not locked (errno 12)');
  expect(locks.readLockedMib()).toBe(0);
});

test('it releases a lock whose build is no longer current when it finishes', async () => {
  const release = mock(() => {});

  const locks = createTemplateLocks({
    lockMemory: () => Promise.resolve({ lock: { lockedBytes: 4096, release } }),
    probeCurrent: () => false,
    logger: getImpdLogger('boot'),
  });

  await locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });

  expect(release).toHaveBeenCalledOnce();
  expect(locks.readLockedMib()).toBe(0);
});

test('it starts no lock once stop is called', async () => {
  const lockMemory = mock(() =>
    Promise.resolve({ lock: { lockedBytes: 4096, release: () => {} } }),
  );

  const locks = createTemplateLocks({
    lockMemory,
    probeCurrent: () => true,
    logger: getImpdLogger('boot'),
  });

  await locks.stop();
  await locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });

  expect(lockMemory).not.toHaveBeenCalled();
});

test('it releases a lock that finishes while stop waits for it', async () => {
  const release = mock(() => {});
  const pending = Promise.withResolvers<MemoryLockResult>();

  const locks = createTemplateLocks({
    lockMemory: () => pending.promise,
    probeCurrent: () => true,
    logger: getImpdLogger('boot'),
  });

  const locking = locks.lock({ key: 'k1', buildId: 'b1', memFile: '/data/templates/k1/mem' });
  const stopping = locks.stop();

  pending.resolve({ lock: { lockedBytes: 4096, release } });

  await Promise.all([locking, stopping]);

  expect(release).toHaveBeenCalledOnce();
  expect(locks.readLockedMib()).toBe(0);
});
