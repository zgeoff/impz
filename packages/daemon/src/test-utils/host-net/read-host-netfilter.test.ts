import { expect, test } from 'bun:test';
import { updateEnv } from '@zgeoff/testing';
import { readHostNetfilter } from './read-host-netfilter';

test('it reports every match when host tests are required', () => {
  updateEnv('IMP_HOST_TESTS', 'required');

  expect(readHostNetfilter()).toStrictEqual({ tables: true, rpfilter: true, hl: true });
});
