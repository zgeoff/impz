import { expect, test } from 'bun:test';
import { buildMockImp } from '@impz/api/test-utils/build-mock-imp';
import { formatCpuUse, formatExposeResult, formatImpInfo, formatImps } from './format-imps';

test('#formatImps notes why an imp boots cold and what it predates', () => {
  // an imp with none of the fields a note reads
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
  // an imp with none of the fields a note reads
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

test('#formatImpInfo shows an awake imp’s container with its restarts and last error', () => {
  const imp = buildMockImp({
    name: 'web',
    state: 'running',
    image: 'base',
    ip: '10.66.0.6',
    url: 'http://web.imp.test',
    inner: { up: false, restarts: 3, lastError: 'start inner init: exit status 1' },
  });

  const { move, agentSilentSince, public: exposure, coldBootReason, outdated, ...quiet } = imp;

  expect(formatImpInfo({ ...quiet, kind: 'user' }).split('\n')).toStrictEqual([
    'name        web',
    'state       running',
    'image       base',
    'ip          10.66.0.6',
    'url         http://web.imp.test',
    'container   down',
    'restarts    3',
    'last error  start inner init: exit status 1',
    'note        container down',
  ]);
});

test('#formatImpInfo shows the container unknown for an awake imp whose agent has not answered', () => {
  const { inner, ...imp } = buildMockImp({ state: 'running' });

  expect(formatImpInfo(imp).split('\n')).toContain('container   unknown');
});

test('#formatImpInfo shows the container not running for a sleeping imp', () => {
  const { inner, ...imp } = buildMockImp({ state: 'sleeping' });

  expect(formatImpInfo(imp).split('\n')).toContain('container   not running');
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

test('#formatCpuUse shows the last sample', () => {
  const imp = buildMockImp({
    cpu: { limit: null },
    resources: {
      sample: {
        measuredAt: new Date(0),
        since: new Date(0),
        cpuPercent: 2,
        cpuThrottledMs: 0,
        netRxBytes: 0,
        netTxBytes: 0,
      },
    },
  });

  expect(formatCpuUse(imp)).toBe('2%');
});

test('#formatCpuUse shows the last sample over the limit', () => {
  const imp = buildMockImp({
    cpu: { limit: 1.5 },
    resources: {
      sample: {
        measuredAt: new Date(0),
        since: new Date(0),
        cpuPercent: 2,
        cpuThrottledMs: 0,
        netRxBytes: 0,
        netTxBytes: 0,
      },
    },
  });

  expect(formatCpuUse(imp)).toBe('2% / 1.5');
});

test('#formatCpuUse shows - for an imp with no sample', () => {
  const imp = buildMockImp({ state: 'sleeping', cpu: { limit: null } });

  expect(formatCpuUse(imp)).toBe('-');
});

test('#formatExposeResult says the URL is public when it made no credential', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'none',
    user: null,
    credential: null,
  });

  expect(printed).toBe('https://web.imp.example.com is public');
});

test('#formatExposeResult prints the warning under the URL', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'none',
    user: null,
    credential: null,
    warning: 'no record',
  });

  expect(printed).toBe('https://web.imp.example.com is public\nwarning: no record');
});

test('#formatExposeResult prints the user and the password it made', () => {
  const printed = formatExposeResult({
    url: 'https://web.imp.example.com',
    auth: 'basic',
    user: 'imp',
    credential: 'pw',
  });

  expect(printed).toBe(
    [
      'https://web.imp.example.com is public',
      'user: imp',
      'password: pw',
      'impd keeps only a hash; expose the imp again for a new one.',
    ].join('\n'),
  );
});
