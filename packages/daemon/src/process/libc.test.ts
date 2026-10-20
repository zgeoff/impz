import { expect, test } from 'bun:test';
import invariant from 'tiny-invariant';
import { readErrno, readLibc, readPidfdLibc } from './libc';

test('#readLibc opens libc once', () => {
  expect(readLibc()).toBe(readLibc());
});

test('#readLibc gives lseek, which reports EBADF for a closed descriptor', () => {
  const libc = readLibc();

  invariant(libc);

  const result = Number(libc.lseek(-1, 0, 0));

  expect(result).toBe(-1);

  // EBADF on Linux
  expect(readErrno()).toBe(9);
});

test('#readPidfdLibc opens the pidfd wrappers once', () => {
  expect(readPidfdLibc()).toBe(readPidfdLibc());
});
