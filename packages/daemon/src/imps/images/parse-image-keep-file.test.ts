import { expect, test } from 'bun:test';
import { parseImageKeepFile } from './parse-image-keep-file';

test('it reads one image name a line, past blank lines and comments', () => {
  expect(
    parseImageKeepFile('# the cloud target\nagent-0a1b2c3\n\n  agent-9f8e7d6  \n'),
  ).toStrictEqual({ isOk: true, names: new Set(['agent-0a1b2c3', 'agent-9f8e7d6']) });
});

test('it reads an empty file as no names', () => {
  expect(parseImageKeepFile('')).toStrictEqual({ isOk: true, names: new Set() });
});

test('it refuses a line that holds no image name, with the line', () => {
  expect(parseImageKeepFile('agent-0a1b2c3\nagent 9f8e7d6\n')).toStrictEqual({
    isOk: false,
    reason: 'line 2 holds "agent 9f8e7d6", which is no image name',
  });
});
