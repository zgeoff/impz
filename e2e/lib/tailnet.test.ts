import { expect, mock, test } from 'bun:test';
import type { CommandRunners } from './instance';
import {
  findServiceUrl,
  findTailnetNode,
  isTailnetReady,
  parseSelfTags,
  parseTailscaleStatus,
  readHarnessMemberStatus,
  readTailnetMember,
} from './tailnet';

test('#findServiceUrl picks the per-imp tailnet name among the URL lines', () => {
  const stdout = [
    'http://e2e-mvt-n.imp.localhost:7080/',
    'http://100.64.0.7:8004/',
    'https://e2e-e2e-mvt-n.tail1234.ts.net',
    '',
  ].join('\n');

  expect(findServiceUrl(stdout)).toBe('https://e2e-e2e-mvt-n.tail1234.ts.net');
});

test('#findServiceUrl gives null before the imp has a tailnet name', () => {
  expect(findServiceUrl('http://e2e-mvt-n.imp.localhost:7080/\n')).toBeNull();
});

test('#isTailnetReady is ready with a key and the member Running', () => {
  expect(isTailnetReady({ BackendState: 'Running' }, true)).toBeTrue();
});

test('#isTailnetReady is not ready without a key', () => {
  expect(isTailnetReady({ BackendState: 'Running' }, false)).toBeFalse();
});

test('#isTailnetReady is not ready while the member is logged out', () => {
  expect(isTailnetReady({ BackendState: 'NeedsLogin' }, true)).toBeFalse();
});

test('#isTailnetReady is not ready without a tailscale status', () => {
  expect(isTailnetReady(null, true)).toBeFalse();
});

test('#parseSelfTags reads the tags the node joined with', () => {
  const stdout = JSON.stringify({
    BackendState: 'Running',
    Self: { HostName: 'imp', Tags: ['tag:imp-e2e'] },
  });

  expect(parseSelfTags(stdout)).toStrictEqual(['tag:imp-e2e']);
});

test('#parseSelfTags reads a node without tags as none', () => {
  expect(parseSelfTags(JSON.stringify({ Self: { HostName: 'imp' } }))).toStrictEqual([]);
});

test('#parseTailscaleStatus reads the backend state and the peers', () => {
  const stdout = JSON.stringify({
    BackendState: 'Running',
    Version: '1.102.3',
    Peer: {
      'nodekey:a': {
        DNSName: 'imp.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.7'],
        Online: true,
        Tags: ['tag:imp-e2e'],
      },
    },
  });

  expect(parseTailscaleStatus(stdout)).toStrictEqual({
    BackendState: 'Running',
    Peer: {
      'nodekey:a': {
        DNSName: 'imp.tail1234.ts.net.',
        TailscaleIPs: ['100.64.0.7'],
        Online: true,
        Tags: ['tag:imp-e2e'],
      },
    },
  });
});

test('#parseTailscaleStatus reads a status without peers as none', () => {
  expect(parseTailscaleStatus(JSON.stringify({ BackendState: 'NeedsLogin' }))).toStrictEqual({
    BackendState: 'NeedsLogin',
    Peer: {},
  });
});

test('#parseTailscaleStatus reads a node alone on its tailnet as one without peers', () => {
  expect(
    parseTailscaleStatus(JSON.stringify({ BackendState: 'Running', Peer: null })),
  ).toStrictEqual({ BackendState: 'Running', Peer: {} });
});

test('#parseTailscaleStatus gives null for output that is not JSON', () => {
  expect(parseTailscaleStatus('tailscale: command not found')).toBeNull();
});

test('#parseTailscaleStatus gives null for JSON without a backend state', () => {
  expect(parseTailscaleStatus(JSON.stringify({ Peer: {} }))).toBeNull();
});

test('#findTailnetNode names the online peer that holds the IP', () => {
  const peers = [
    { DNSName: 'imp.tail1234.ts.net.', TailscaleIPs: ['100.64.0.2'], Online: false },
    {
      DNSName: 'imp-1.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.7', 'fd7a:115c:a1e0::7'],
      Online: true,
    },
  ];

  expect(findTailnetNode(peers, '100.64.0.7')).toStrictEqual({
    fqdn: 'imp-1.tail1234.ts.net',
    short: 'imp-1',
    tags: [],
  });
});

test('#findTailnetNode gives the tags the node joined with', () => {
  const peers = [
    {
      DNSName: 'imp.tail1234.ts.net.',
      TailscaleIPs: ['100.64.0.7'],
      Online: true,
      Tags: ['tag:imp-e2e'],
    },
  ];

  expect(findTailnetNode(peers, '100.64.0.7')).toStrictEqual({
    fqdn: 'imp.tail1234.ts.net',
    short: 'imp',
    tags: ['tag:imp-e2e'],
  });
});

test('#findTailnetNode passes over an offline peer that holds the IP', () => {
  const peers = [{ DNSName: 'imp.tail1234.ts.net.', TailscaleIPs: ['100.64.0.7'], Online: false }];

  expect(findTailnetNode(peers, '100.64.0.7')).toBeNull();
});

test('#findTailnetNode gives null for a peer without a MagicDNS name', () => {
  const peers = [{ DNSName: '', TailscaleIPs: ['100.64.0.7'], Online: true }];

  expect(findTailnetNode(peers, '100.64.0.7')).toBeNull();
});

test('#readTailnetMember names the member container the harness started', () => {
  expect(readTailnetMember({ E2E_TAILNET_MEMBER: 'imp-e2e-a-ts-member' })).toBe(
    'imp-e2e-a-ts-member',
  );
});

test('#readHarnessMemberStatus gives no status outside a harness run that started the tailnet', async () => {
  const runCommand = mock<CommandRunners['runCommand']>();

  const status = await readHarnessMemberStatus({ runCommand }, {});

  expect(status).toBeNull();
  expect(runCommand).not.toHaveBeenCalled();
});

test('#readHarnessMemberStatus reads the status of the member the harness started', async () => {
  const runCommand = mock<CommandRunners['runCommand']>(() =>
    Promise.resolve({ exitCode: 0, stdout: '{"BackendState": "Running"}', stderr: '' }),
  );

  const status = await readHarnessMemberStatus(
    { runCommand },
    { E2E_TAILNET_MEMBER: 'imp-e2e-a-ts-member' },
  );

  expect(status).toStrictEqual({ BackendState: 'Running', Peer: {} });

  expect(runCommand).toHaveBeenCalledExactlyOnceWith([
    'docker',
    'exec',
    'imp-e2e-a-ts-member',
    'tailscale',
    'status',
    '--json',
  ]);
});

test('#readTailnetMember fails outside a harness run that started the tailnet', () => {
  expect(() => readTailnetMember({})).toThrowWithMessage(
    Error,
    'no E2E_TAILNET_MEMBER: the e2e harness starts the tailnet for this suite',
  );
});
