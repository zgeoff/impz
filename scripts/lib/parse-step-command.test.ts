import { expect, test } from 'bun:test';
import { parseStepCommand } from './parse-step-command';

test('it returns the values of a command that fills every argument', () => {
  expect(
    parseStepCommand(
      'collect-logs.ts',
      [{ name: 'engine', choices: ['docker', 'podman'] }, { name: 'container' }],
      ['podman', 'imp-dev'],
    ),
  ).toStrictEqual({ isValid: true, values: ['podman', 'imp-dev'] });
});

test('it returns the values of a command that leaves out an optional argument', () => {
  expect(
    parseStepCommand(
      'set-up.ts',
      [{ name: 'task' }, { name: 'arc', isOptional: true }],
      ['install-zfs'],
    ),
  ).toStrictEqual({ isValid: true, values: ['install-zfs'] });
});

test.each([
  ['a missing argument', ['podman']],
  ['an extra argument', ['podman', 'imp-dev', 'extra']],
  ['a value outside its choices', ['lxc', 'imp-dev']],
  ['a flag', ['podman', '--follow', 'imp-dev']],
  ['an option terminator', ['podman', '--', 'imp-dev']],
])('it refuses %s with the usage line', (_, argv) => {
  expect(
    parseStepCommand(
      'collect-logs.ts',
      [{ name: 'engine', choices: ['docker', 'podman'] }, { name: 'container' }],
      argv,
    ),
  ).toStrictEqual({ isValid: false, usage: 'usage: collect-logs.ts <docker|podman> <container>' });
});

test('it shows an optional argument in brackets in the usage line', () => {
  expect(
    parseStepCommand('set-up.ts', [{ name: 'task' }, { name: 'arc', isOptional: true }], []),
  ).toStrictEqual({ isValid: false, usage: 'usage: set-up.ts <task> [arc]' });
});
