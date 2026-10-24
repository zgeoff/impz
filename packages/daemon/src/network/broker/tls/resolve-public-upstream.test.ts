import { expect, test } from 'bun:test';
import { resolvePublicUpstream } from './resolve-public-upstream';

test('it sends a host to its public HTTPS origin with the system roots', () => {
  expect(resolvePublicUpstream('api.github.com')).toStrictEqual({
    origin: 'https://api.github.com',
    ca: null,
  });
});
