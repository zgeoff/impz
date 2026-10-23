import { expect, test } from 'bun:test';
import { buildWithout } from './build-without';

test('it leaves out the named keys and keeps every other entry', () => {
  expect(
    buildWithout({ PATH: '/usr/bin', TAILSCALE_AUTHKEY: 'fake-key', HOME: '/home/ci' }, [
      'TAILSCALE_AUTHKEY',
    ]),
  ).toStrictEqual({ PATH: '/usr/bin', HOME: '/home/ci' });
});

test('it keeps an entry whose value is undefined', () => {
  expect(buildWithout({ PATH: '/usr/bin', EMPTY: undefined }, ['HOME'])).toStrictEqual({
    PATH: '/usr/bin',
    EMPTY: undefined,
  });
});

test('it leaves the given record unchanged', () => {
  const record = { anyOf: [], type: 'object' };

  buildWithout(record, ['anyOf']);

  expect(record).toStrictEqual({ anyOf: [], type: 'object' });
});
