import { expect, test } from 'bun:test';
import { toProcessEnv } from './to-process-env.ts';

test('it keeps each variable that holds a value, an empty one included', () => {
  expect(toProcessEnv({ IMP_DEV_NAME: 'imp-a', IMP_DEV_IP: '' })).toStrictEqual({
    IMP_DEV_NAME: 'imp-a',
    IMP_DEV_IP: '',
  });
});

test('it drops a variable that is unset', () => {
  expect(toProcessEnv({ IMP_DEV_NAME: 'imp-a', IMP_DEV_IP: undefined })).toStrictEqual({
    IMP_DEV_NAME: 'imp-a',
  });
});
