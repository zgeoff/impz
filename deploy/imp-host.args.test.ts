import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseHostArgs } from '../scripts/render/render-imp-host';

test('it runs nothing --privileged', () => {
  const args = parseHostArgs(readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'));
  const words = [...args.privileges, ...args.lines];

  expect(words.flat()).not.toContain('--privileged');
});

test('it gives imp-host no Docker socket', () => {
  const args = parseHostArgs(readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'));
  const hostWords = [...args.privileges, ...args.lines].flat();

  expect(hostWords.filter((word) => /docker/v.test(word))).toStrictEqual([]);
});

test('it probes only devices that compose.zfs.yaml passes', () => {
  const override = readFileSync(new URL('compose.zfs.yaml', import.meta.url), 'utf8');

  const probed = parseHostArgs(
    readFileSync(new URL('imp-host.args.json', import.meta.url), 'utf8'),
  ).probed;

  expect(
    probed.filter((entry) => entry.args[0] === '--device').map((entry) => `- ${entry.path}`),
  ).toSatisfyAll((line: string) => override.includes(line));
});
