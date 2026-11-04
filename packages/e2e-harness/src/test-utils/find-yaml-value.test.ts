import { expect, test } from 'bun:test';
import { findYamlValue } from './find-yaml-value';

test('it finds a value down a path of keys and indexes', () => {
  const workflow = Bun.YAML.parse(
    [
      'jobs:',
      '  e2e:',
      '    strategy:',
      '      matrix:',
      '        include:',
      '          - group: 1',
      '          - group: 2',
    ].join('\n'),
  );

  expect(
    findYamlValue(workflow, ['jobs', 'e2e', 'strategy', 'matrix', 'include', 1, 'group']),
  ).toBe(2);
});

test('it finds the whole value for an empty path', () => {
  expect(findYamlValue({ jobs: {} }, [])).toStrictEqual({ jobs: {} });
});

test('it finds nothing past a key the value lacks', () => {
  expect(findYamlValue({ jobs: { e2e: {} } }, ['jobs', 'zfs', 'needs'])).toBeUndefined();
});

test('it finds nothing inside a scalar', () => {
  expect(findYamlValue({ jobs: 'none' }, ['jobs', 'length'])).toBeUndefined();
});
