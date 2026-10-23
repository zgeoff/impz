import { expect, test } from 'bun:test';
import { DEV_USAGE, parseDevCommand } from './parse-dev-command.ts';

test.each([
  ['up', ['up'], 'up'],
  ['prune', ['prune'], 'prune'],
  ['the first word of several', ['logs', 'extra'], 'logs'],
  ['the first word when a flag follows it', ['down', '--verbose'], 'down'],
] as const)('it reads %s as the command', (_label, argv, command) => {
  expect(parseDevCommand(argv)).toBe(command);
});

test.each([
  ['no word', []],
  ['an unknown word', ['start']],
  ['a flag alone', ['--help']],
  ['a flag before the command', ['--verbose', 'down']],
])('it reads %s as no command', (_label, argv) => {
  expect(parseDevCommand(argv)).toBeNull();
});

test('it names every command in the usage line', () => {
  expect(DEV_USAGE).toBe('usage: scripts/dev/dev.sh up|down|reboot|logs|restart|shell|token|prune');
});
