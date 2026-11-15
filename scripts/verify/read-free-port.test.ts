import { expect, onTestFinished, test } from 'bun:test';
import { WringerError } from '@wringer/core';
import { readFreePort } from './read-free-port.ts';

test('it returns a port below the imps slot ports that a listener can bind', () => {
  const port = readFreePort();
  const listener = Bun.listen({ hostname: '127.0.0.1', port, socket: { data: () => {} } });

  onTestFinished(() => {
    listener.stop(true);
  });

  expect(port).toBeWithin(10_000, 20_000);
});

test('it fails at once when the machine refuses the bind', () => {
  expect(() =>
    readFreePort(() => {
      throw Object.assign(new Error('bind refused'), { code: 'EACCES' });
    }),
  ).toThrowWithMessage(WringerError, /no loopback port can be/u);
});

test('it gives up when every port it tries is taken', () => {
  expect(() =>
    readFreePort(() => {
      throw Object.assign(new Error('port taken'), { code: 'EADDRINUSE' });
    }),
  ).toThrowWithMessage(WringerError, /after 100 tries/u);
});

test('it tries another port when the first is taken', () => {
  const tried: number[] = [];

  const port = readFreePort((candidate) => {
    tried.push(candidate);

    if (tried.length === 1) {
      throw Object.assign(new Error('port taken'), { code: 'EADDRINUSE' });
    }
  });

  expect(tried).toStrictEqual([expect.any(Number), port]);
});
