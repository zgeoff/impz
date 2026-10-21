import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { formatImps } from './format-imps';

test('#formatImps notes why an imp boots cold and what it predates', () => {
  const {
    move,
    agentSilentSince,
    public: exposure,
    coldBootReason,
    outdated,
    ...imp
  } = buildMockImp({ state: 'sleeping', kind: 'user' });

  const rows = formatImps([
    { ...imp, coldBootReason: 'firecrackerVersion changed (v1.17.0 → v1.18.0)' },
    { ...imp, name: 'web', state: 'running', coldBootReason: 'wake failed', outdated: ['agent'] },
    { ...imp, name: 'db', outdated: ['kernel', 'agent'] },
    { ...imp, name: 'old', state: 'running', outdated: ['impd'] },
    { ...imp, name: 'deaf', state: 'running', agentSilentSince: new Date(60_000) },
    { ...imp, name: 'pub', public: { auth: 'token' } },
    { ...imp, name: 'open', public: { auth: 'none' } },
    { ...imp, name: 'v4', state: 'running', outdated: ['ipv6'] },
    { ...imp, name: 'away', state: 'stopped', move: 'moved' },
    { ...imp, name: 'here', state: 'stopped', move: 'receiving', outdated: ['agent'] },
    { ...imp, name: 'build', kind: 'builder' },
  ]).split('\n');

  const notes = rows.map((row) => row.slice(rows[0]?.indexOf('NOTE')));

  expect(notes).toStrictEqual([
    'NOTE',
    'boots cold: firecrackerVersion changed (v1.17.0 → v1.18.0)',
    'booted cold: wake failed; outdated: agent',
    'outdated: kernel, agent',
    'booted by an older impd; its next wake boots cold',
    'agent silent since 1970-01-01T00:01:00.000Z',
    'public (token)',
    'public',
    'no IPv6 until its next cold boot',
    'moved',
    'receiving; outdated: agent',
    'image builder',
  ]);
});

test('#formatImps notes an inner container that is down, and none that is up', () => {
  const {
    move,
    agentSilentSince,
    public: exposure,
    coldBootReason,
    outdated,
    inner,
    ...imp
  } = buildMockImp({ state: 'running', kind: 'user' });

  const rows = formatImps([
    { ...imp, name: 'down', inner: { up: false, restarts: 3 } },
    { ...imp, name: 'up', inner: { up: true, restarts: 0 } },
    { ...imp, name: 'unknown' },
  ]).split('\n');

  const notes = rows.map((row) => row.slice(rows[0]?.indexOf('NOTE')).trimEnd());

  expect(notes).toStrictEqual(['NOTE', 'container down', '', '']);
});

test('#formatImps counts sessions, and shows - when impd has not seen them', () => {
  const { sessions, ...imp } = buildMockImp();
  const rows = formatImps([{ ...imp, sessions: 2 }, imp]).split('\n');
  const column = rows.map((row) => row.slice(rows[0]?.indexOf('SESSIONS')).split(/\s+/u)[0]);

  expect(column).toStrictEqual(['SESSIONS', '2', '-']);
});

test('#formatImps shows what a destroy frees and what the imp shares', () => {
  const { diskUsage, ...imp } = buildMockImp();

  const usage = {
    exclusiveBytes: 300 * 1_048_576,
    sharedBytes: 1200 * 1_048_576,
    measuredAt: new Date(0),
    isPartial: false,
    isUpperBound: false,
  };

  const rows = formatImps([
    { ...imp, diskUsage: usage },
    { ...imp, diskUsage: { ...usage, isUpperBound: true, isPartial: true } },
    imp,
  ]).split('\n');

  const start = rows[0]?.indexOf('USED') ?? 0;

  const cells = rows.map((row) =>
    row
      .slice(start)
      .split(/\s{2,}/u)
      .slice(0, 2),
  );

  expect(cells).toStrictEqual([
    ['USED', 'SHARED'],
    ['300 MiB', '1.2 GiB'],
    ['<=300 MiB?', '1.2 GiB?'],
    ['-', '-'],
  ]);
});
