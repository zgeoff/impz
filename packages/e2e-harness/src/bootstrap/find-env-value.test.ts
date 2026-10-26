import { expect, test } from 'bun:test';
import { findEnvValue } from './find-env-value';

test('it finds the value of the last line for the key', () => {
  expect(
    findEnvValue(
      'IMP_HOST_IPV6=off\nIMP_HOST_SUBNET6=fd12::/64\nIMP_HOST_IPV6=on\n',
      'IMP_HOST_IPV6',
    ),
  ).toBe('on');
});

test('it finds an empty value', () => {
  expect(findEnvValue('IMP_HOST_NETWORK=\n', 'IMP_HOST_NETWORK')).toBe('');
});

test('it misses a key that only another key starts with', () => {
  expect(findEnvValue('IMP_HOST_IPV6_EXTRA=on\n', 'IMP_HOST_IPV6')).toBeNull();
});

test('it keeps an equals sign inside the value', () => {
  expect(findEnvValue('IMP_HOST_NETWORK=--network=imp-host\n', 'IMP_HOST_NETWORK')).toBe(
    '--network=imp-host',
  );
});
