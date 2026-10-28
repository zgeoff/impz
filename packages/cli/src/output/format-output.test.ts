import { expect, test } from 'bun:test';
import { buildMockApiCall } from '@impz/api/test-utils/build-mock-api-call';
import { buildMockCheckpoint } from '@impz/api/test-utils/build-mock-checkpoint';
import { buildMockIdentity } from '@impz/api/test-utils/build-mock-identity';
import { buildMockImage } from '@impz/api/test-utils/build-mock-image';
import { buildMockRefusedRequest } from '@impz/api/test-utils/build-mock-refused-request';
import { buildMockSession } from '@impz/api/test-utils/build-mock-session';
import { buildMockToken } from '@impz/api/test-utils/build-mock-token';
import {
  formatApiCalls,
  formatBootStatus,
  formatCheckpoints,
  formatGc,
  formatGrants,
  formatHttps,
  formatIdentity,
  formatImages,
  formatRefusedRequests,
  formatSessions,
  formatSshKey,
  formatTable,
  formatTokens,
} from './format-output';

test('#formatTable pads each column to its widest cell', () => {
  const table = formatTable(
    ['NAME', 'STATE'],
    [
      ['dev', 'running'],
      ['scratchpad', 'sleeping'],
    ],
  );

  expect(table).toBe(
    ['NAME        STATE', 'dev         running', 'scratchpad  sleeping'].join('\n'),
  );
});

test('#formatCheckpoints lists checkpoints with their size in MiB and their disk size', () => {
  const { label, sizeBytes, ...older } = buildMockCheckpoint({
    id: 'cp-d5e6f7',
    createdAt: new Date(0),
    diskMib: 65_536 + 512,
  });

  const table = formatCheckpoints([
    buildMockCheckpoint({
      id: 'cp-a2b3c4',
      label: 'clean',
      createdAt: new Date(0),
      sizeBytes: 3_145_728,
      diskMib: 32_768,
    }),
    older,
  ]);

  expect(table.split('\n')).toStrictEqual([
    'ID         LABEL  CREATED                   SIZE   DISK',
    'cp-a2b3c4  clean  1970-01-01T00:00:00.000Z  3 MiB  32.0 GiB',
    'cp-d5e6f7         1970-01-01T00:00:00.000Z         64.5 GiB',
  ]);
});

test('#formatSessions lists sessions with their state, size and command', () => {
  const table = formatSessions([
    buildMockSession({
      name: 'main',
      pid: 301,
      argv: ['bash', '-l'],
      state: 'running',
      attached: true,
      cols: 120,
      rows: 40,
      startedAt: new Date(0),
    }),
    buildMockSession({
      name: 'job',
      pid: 302,
      argv: ['make'],
      state: 'exited',
      attached: false,
      cols: 80,
      rows: 24,
      startedAt: new Date(0),
      exit: { code: 3, signal: null },
    }),
    buildMockSession({
      name: 'hung',
      pid: 303,
      argv: ['sleep', '60'],
      state: 'exited',
      attached: false,
      cols: 80,
      rows: 24,
      startedAt: new Date(0),
      exit: { code: null, signal: 'SIGKILL' },
    }),
  ]);

  expect(table.split('\n')).toStrictEqual([
    'NAME  STATE             ATTACHED  PID  SIZE    STARTED                   COMMAND',
    'main  running           yes       301  120x40  1970-01-01T00:00:00.000Z  bash -l',
    'job   exited (code 3)   no        302  80x24   1970-01-01T00:00:00.000Z  make',
    'hung  exited (SIGKILL)  no        303  80x24   1970-01-01T00:00:00.000Z  sleep 60',
  ]);
});

test('#formatBootStatus says none when no imp boots cold or runs an older part', () => {
  const status = formatBootStatus(
    { coldBoots: 0, outdated: { firecracker: 0, kernel: 0, agent: 0 } },
    '0.2.0',
  );

  expect(status).toBe('none');
});

test('#formatBootStatus says how many imps will boot cold and run each older part', () => {
  const status = formatBootStatus(
    { coldBoots: 3, outdated: { firecracker: 1, kernel: 0, agent: 2 } },
    '0.2.0',
  );

  expect(status).toBe('3 will boot cold; outdated: 1 firecracker, 2 agent');
});

test('#formatBootStatus lists the older parts alone when no imp boots cold', () => {
  const status = formatBootStatus(
    { coldBoots: 0, outdated: { firecracker: 0, kernel: 1, agent: 0 } },
    '0.2.0',
  );

  expect(status).toBe('outdated: 1 kernel');
});

test('#formatBootStatus says an older impd does not report boot status', () => {
  const status = formatBootStatus(undefined, '0.1.0');

  expect(status).toBe('unknown (impd 0.1.0 predates it)');
});

test('#formatGc lists what it removed', () => {
  const printed = formatGc({
    dryRun: false,
    dropped: [
      { kind: 'imp', id: 'lost' },
      { kind: 'checkpoint', id: 'cp-a2b3c4' },
    ],
  });

  expect(printed.split('\n')).toStrictEqual([
    'KIND        ID',
    'imp         lost',
    'checkpoint  cp-a2b3c4',
  ]);
});

test('#formatGc says a dry run removed nothing', () => {
  const printed = formatGc({
    dryRun: true,
    dropped: [
      { kind: 'imp', id: 'lost' },
      { kind: 'checkpoint', id: 'cp-a2b3c4' },
    ],
  });

  expect(printed.split('\n')).toStrictEqual([
    'KIND        ID',
    'imp         lost',
    'checkpoint  cp-a2b3c4',
    '(dry run: nothing removed)',
  ]);
});

test('#formatGc says when there is nothing to remove', () => {
  expect(formatGc({ dryRun: false, dropped: [] })).toBe('nothing to remove');
});

test('#formatGc lists the orphans it kept, with their size, age and snapshots', () => {
  const printed = formatGc({
    dryRun: false,
    dropped: [],
    kept: [
      {
        kind: 'imp',
        id: 'a',
        location: 'tank/imp/disks/a',
        bytes: 3_145_728,
        createdAt: new Date('2026-10-03T00:00:00Z'),
        snapshots: ['cp-1', 'cp-2'],
      },
      {
        kind: 'image',
        id: '9f2c',
        location: '/var/lib/imp/images/9f2c',
        bytes: 0,
        createdAt: null,
        snapshots: [],
      },
    ],
  });

  expect(printed.split('\n')).toStrictEqual([
    'nothing to remove',
    '',
    'kept 2 orphans the database does not name; `impz gc --orphans` retires them:',
    'KIND   ID    LOCATION                  SIZE     CREATED                   SNAPSHOTS',
    'imp    a     tank/imp/disks/a          3.0 MiB  2026-10-03T00:00:00.000Z  cp-1,cp-2',
    'image  9f2c  /var/lib/imp/images/9f2c  0 B      -                         -',
  ]);
});

test('#formatGc shows how many files each directory of kept secret values holds', () => {
  const printed = formatGc({
    dryRun: false,
    dropped: [],
    kept: [
      {
        kind: 'secrets',
        id: '2026-10-04T05-30-00.000Z',
        location: '/var/lib/imp/secrets/.orphaned/2026-10-04T05-30-00.000Z',
        bytes: 8,
        createdAt: new Date('2026-10-04T05:30:00.000Z'),
        snapshots: [],
        files: ['late.b2', '.crashed.c3'],
      },
    ],
  });

  expect(printed.split('\n')).toStrictEqual([
    'nothing to remove',
    '',
    'kept 1 orphans the database does not name; `impz gc --orphans` retires them:',
    'KIND     ID                        LOCATION                                                 SIZE  CREATED                   SNAPSHOTS',
    'secrets  2026-10-04T05-30-00.000Z  /var/lib/imp/secrets/.orphaned/2026-10-04T05-30-00.000Z  8 B   2026-10-04T05:30:00.000Z  2 files',
  ]);
});

test('#formatTokens lists tokens with their scope and imps, and * for every imp', () => {
  const createdAt = new Date('2026-10-02T00:00:00Z');

  const text = formatTokens([
    buildMockToken({
      name: 'ci',
      scope: 'manage',
      imps: ['dev-*', 'ci-*'],
      sshKeys: [{ fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: 'me@laptop' }],
      grantable: ['gh', 'npm'],
      imageRefPrefix: 'ghcr.io/org/ci-',
      createdAt,
    }),
    buildMockToken({
      name: 'ops',
      scope: 'manage',
      imps: null,
      grantable: [],
      imageRefPrefix: null,
      createdAt,
    }),
  ]);

  expect(text.split('\n').map((line) => line.trimEnd())).toStrictEqual([
    'NAME  SCOPE   IMPS        GRANTABLE  IMAGE REF PREFIX  SSH KEYS  CREATED',
    'ci    manage  dev-*,ci-*  gh,npm     ghcr.io/org/ci-   1         2026-10-02T00:00:00.000Z',
    'ops   manage  *           -          -                 0         2026-10-02T00:00:00.000Z',
  ]);
});

test('#formatTokens lists a token from an impd that sends no grantable list or prefix', () => {
  const createdAt = new Date('2026-10-02T00:00:00Z');

  const { grantable, imageRefPrefix, ...older } = buildMockToken({
    name: 'ci',
    scope: 'exec',
    imps: null,
    sshKeys: [],
    createdAt,
  });

  const text = formatTokens([older]);

  expect(text.split('\n').map((line) => line.trimEnd())).toStrictEqual([
    'NAME  SCOPE  IMPS  GRANTABLE  IMAGE REF PREFIX  SSH KEYS  CREATED',
    'ci    exec   *     -          -                 0         2026-10-02T00:00:00.000Z',
  ]);
});

test('#formatSshKey prints a key as ssh-keygen -l does', () => {
  const printed = formatSshKey({
    fingerprint: 'SHA256:abc',
    type: 'ssh-ed25519',
    comment: 'me@laptop',
  });

  expect(printed).toBe('SHA256:abc me@laptop');
});

test('#formatSshKey prints the fingerprint alone for a key with no comment', () => {
  const printed = formatSshKey({ fingerprint: 'SHA256:abc', type: 'ssh-ed25519', comment: '' });

  expect(printed).toBe('SHA256:abc');
});

test('#formatIdentity names the caller and its scope on every imp', () => {
  const identity = buildMockIdentity({
    kind: 'tailnet',
    name: 'me@example.com',
    scope: 'read',
    imps: null,
    grantable: [],
  });

  expect(formatIdentity(identity)).toBe('tailnet me@example.com: read on every imp');
});

test('#formatIdentity names the imp patterns and the secrets the caller may grant', () => {
  const identity = buildMockIdentity({
    kind: 'token',
    name: 'agent',
    scope: 'manage',
    imps: ['agent-*'],
    grantable: ['gh', 'npm'],
  });

  expect(formatIdentity(identity)).toBe('token agent: manage on agent-*; may grant gh,npm');
});

test('#formatIdentity names the image ref prefix the caller may add images from', () => {
  const identity = buildMockIdentity({
    kind: 'token',
    name: 'tansy',
    scope: 'manage',
    imps: ['tansy-*'],
    grantable: [],
    imageRefPrefix: 'ghcr.io/zgeoff/tansy-',
  });

  expect(formatIdentity(identity)).toBe(
    'token tansy: manage on tansy-*; may add images from ghcr.io/zgeoff/tansy-',
  );
});

test('#formatIdentity names a caller from an impd that sends no grantable list', () => {
  const { grantable, ...identity } = buildMockIdentity({
    kind: 'token',
    name: 'ci',
    scope: 'read',
    imps: null,
  });

  expect(formatIdentity(identity)).toBe('token ci: read on every imp');
});

test('#formatRefusedRequests lists each refusal with its reason, and a dash for what it lacks', () => {
  const text = formatRefusedRequests([
    buildMockRefusedRequest({
      at: new Date(0),
      imp: 'dev',
      method: 'CONNECT',
      host: 'exfil.test',
      path: null,
      status: 403,
      durationMs: 1,
      reason: 'egress-policy',
    }),
    buildMockRefusedRequest({
      at: new Date(0),
      imp: 'dev',
      method: null,
      host: null,
      path: null,
      status: 400,
      durationMs: 0,
      reason: 'not-http',
    }),
  ]);

  expect(text.split('\n')).toStrictEqual([
    'TIME                      IMP  METHOD   HOST        PATH  STATUS  MS  REASON',
    '1970-01-01T00:00:00.000Z  dev  CONNECT  exfil.test  -     403     1   egress-policy',
    '1970-01-01T00:00:00.000Z  dev  -        -           -     400     0   not-http',
  ]);
});

test('#formatGrants lists each grant’s methods and paths, and a star for a list it leaves out', () => {
  const text = formatGrants([
    { secret: 'gh', filter: { methods: ['GET', 'HEAD'], paths: ['/repos/**', '/user'] } },
    { secret: 'model', filter: { paths: ['/v1/messages'] } },
    { secret: 'npm', filter: null },
  ]);

  expect(text.split('\n')).toStrictEqual([
    'SECRET  METHODS   PATHS',
    'gh      GET,HEAD  /repos/**,/user',
    'model   *         /v1/messages',
    'npm     *         *',
  ]);
});

test('#formatApiCalls names who made each api call', () => {
  const { actorName, imp, ...dashboard } = buildMockApiCall({
    at: new Date(0),
    procedure: 'imps.stop',
    actor: 'dashboard',
    outcome: 'ok',
    durationMs: 3,
  });

  const text = formatApiCalls([
    buildMockApiCall({
      at: new Date(0),
      procedure: 'imps.stop',
      actor: 'token',
      actorName: 'ci',
      imp: 'dev',
      outcome: 'ok',
      durationMs: 3,
    }),
    dashboard,
  ]);

  expect(text.split('\n')).toStrictEqual([
    'TIME                      IMP  PROCEDURE  ACTOR      OUTCOME  MS  DETAIL',
    '1970-01-01T00:00:00.000Z  dev  imps.stop  token ci   ok       3   -',
    '1970-01-01T00:00:00.000Z  -    imps.stop  dashboard  ok       3   -',
  ]);
});

test('#formatApiCalls ends the line with the detail of a call', () => {
  const pulled = `busybox@sha256:${'b'.repeat(64)}`;
  const text = formatApiCalls([buildMockApiCall({ procedure: 'images.add', detail: pulled })]);

  expect(text.split('\n')[1]).toEndWith(`  ${pulled}`);
});

test('#formatImages lists each image with its short digest, its size in MiB and its pin', () => {
  const text = formatImages([
    buildMockImage({
      name: 'base',
      ref: 'busybox:1.37',
      digest: `sha256:${'a'.repeat(64)}`,
      sizeBytes: 5 * 1_048_576,
      pinned: true,
    }),
    buildMockImage({
      name: 'tools',
      ref: 'alpine:3.22',
      digest: `sha256:${'b'.repeat(64)}`,
      sizeBytes: 9 * 1_048_576,
      pinned: false,
    }),
  ]);

  expect(text.split('\n')).toStrictEqual([
    'NAME   REF           DIGEST               SIZE   PINNED',
    'base   busybox:1.37  sha256:aaaaaaaaaaaa  5 MiB  yes',
    'tools  alpine:3.22   sha256:bbbbbbbbbbbb  9 MiB  -',
  ]);
});

test('#formatHttps shows nothing for an impd that does not report HTTPS', () => {
  expect(formatHttps(undefined)).toBeEmpty();
});

test('#formatHttps says HTTPS is off without IMP_DOMAIN', () => {
  expect(formatHttps(null)).toStrictEqual([['https', 'off (IMP_DOMAIN unset)']]);
});

test('#formatHttps names the domain when no DNS token file is read', () => {
  expect(formatHttps({ domain: 'imp.example.com', dnsToken: null })).toStrictEqual([
    ['https', 'imp.example.com'],
  ]);
});

test('#formatHttps says the DNS token file is readable', () => {
  const rows = formatHttps({
    domain: 'imp.example.com',
    dnsToken: { isOk: true, error: null, at: new Date(0) },
  });

  expect(rows).toStrictEqual([['https', 'imp.example.com, DNS token file readable']]);
});

test('#formatHttps names a DNS token that fails as an error, with its file', () => {
  const rows = formatHttps({
    domain: 'imp.example.com',
    dnsToken: {
      isOk: false,
      error: 'cannot read the DNS API token from /etc/imp/dns-api-token: ENOENT',
      at: new Date(0),
    },
  });

  expect(rows).toStrictEqual([
    [
      'https',
      'imp.example.com, ERROR: cannot read the DNS API token from /etc/imp/dns-api-token: ENOENT',
    ],
  ]);
});
