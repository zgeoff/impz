import { expect, test } from 'bun:test';
import { parseBenchPrefix } from './parse-bench-prefix';

test('it starts each imp name with the prefix, then the run ID', () => {
  expect(parseBenchPrefix('bench-wake-', { runID: '0123456789ab', levels: [1] })).toBe(
    'bench-wake-0123456789ab-',
  );
});

test('it takes a prefix whose longest name fits an imp name at its top concurrency', () => {
  expect(parseBenchPrefix('bench-wakes-x-', { runID: '0123456789ab', levels: [1] })).toBe(
    'bench-wakes-x-0123456789ab-',
  );
});

test.each([
  ['bench-wakes-x-', [1, 64], 'bench-wakes-x-0123456789ab-64-63'],
  ['Bench-', [1], 'Bench-0123456789ab-1-0'],
  ['7-', [1], '7-0123456789ab-1-0'],
])(
  'it refuses the prefix %p at concurrency %p, and names the imp name it would give',
  (text, levels, longest) => {
    expect(() => parseBenchPrefix(text, { runID: '0123456789ab', levels })).toThrowWithMessage(
      Error,
      `--prefix ${text} gives imp names such as ${longest}, but an imp name must be a lowercase letter followed by up to 30 lowercase letters, digits or hyphens`,
    );
  },
);
