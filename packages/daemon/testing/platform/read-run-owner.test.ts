import { expect, test } from 'bun:test';
import { readRunOwner } from './read-run-owner';

test('it reads the PID and the PID namespace of the test process', () => {
  expect(readRunOwner()).toStrictEqual({
    pid: process.pid,
    namespace: expect.stringMatching(/^\d+$/u),
  });
});
