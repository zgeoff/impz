import { expect, test } from 'bun:test';
import { getStepEnv } from './get-step-env';

test('it returns the value the step sets', () => {
  expect(getStepEnv({ TAG: 'v1.2.3' }, 'TAG')).toBe('v1.2.3');
});

test('it returns an empty value as it is', () => {
  expect(getStepEnv({ TAG: '' }, 'TAG')).toBe('');
});

test('it throws for a name the step leaves out', () => {
  expect(() => getStepEnv({}, 'TAG')).toThrowWithMessage(Error, 'the step sets no TAG in its env');
});
