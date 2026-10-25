import { expect, test } from 'bun:test';
import { formatEngineFailure, formatRefusal } from './refusal';

test('#formatRefusal prefixes the reason with the proxy name', () => {
  expect(formatRefusal('no')).toBe('imp-docker-proxy: no');
});

test('#formatEngineFailure names the engine call that failed', () => {
  expect(formatEngineFailure('connect ENOENT')).toBe(
    'imp-docker-proxy: the engine call failed: connect ENOENT',
  );
});
