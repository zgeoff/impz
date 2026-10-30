import { expect, test } from 'bun:test';
import { formatStepValues } from './format-step-values';

test('it formats one name=value line for each value, in order', () => {
  expect(formatStepValues({ version: '1.2.3', push_tag: 'dryrun-0123456789ab' })).toBe(
    'version=1.2.3\npush_tag=dryrun-0123456789ab\n',
  );
});

test('it formats no values as nothing', () => {
  expect(formatStepValues({})).toBe('');
});
