import type {
  ApiCall,
  AuditEntry,
  BackupRun,
  BackupStatus,
  Checkpoint,
  Grant,
  Identity,
  Image,
  ImageBuildRun,
  Network,
  OAuthApproval,
  OAuthClient,
  OAuthGrant,
  OrphanStorage,
  RefusedRequest,
  Secret,
  Service,
  Session,
  SessionLog,
  SshKey,
  StorageGc,
  SystemInfo,
  Token,
} from '@impz/api';
import { formatBytes, formatDuration, formatMib } from '@impz/shared';

export type Row = readonly string[];

export function formatTable(header: Row, rows: readonly Row[]): string {
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (row[column] ?? '').length)),
  );

  return [header, ...rows]
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function formatCheckpoints(checkpoints: readonly Checkpoint[]): string {
  return formatTable(
    ['ID', 'LABEL', 'CREATED', 'SIZE', 'DISK'],
    checkpoints.map((checkpoint) => [
      checkpoint.id,
      checkpoint.label ?? '',
      checkpoint.createdAt.toISOString(),
      checkpoint.sizeBytes === undefined
        ? ''
        : `${String(Math.round(checkpoint.sizeBytes / 1_048_576))} MiB`,
      formatMib(checkpoint.diskMib),
    ]),
  );
}

export function formatBackupStatus(status: Readonly<BackupStatus>): string {
  const table = formatTable(
    ['ID', 'TIME (UTC)', 'IMPS'],
    status.points.map((point) => [
      point.id.slice(0, 8),
      point.time.toISOString(),
      point.imps.join(' '),
    ]),
  );

  const check =
    status.lastCheck === null
      ? 'never'
      : `${status.lastCheck.at.toISOString()} ${status.lastCheck.error === undefined ? 'ok' : `FAILED: ${status.lastCheck.error}`}`;

  return [
    table,
    '',
    `last run:   ${status.lastRunAt?.toISOString() ?? 'never'}`,
    `last prune: ${status.lastPruneAt?.toISOString() ?? 'never'}`,
    `last check: ${check}`,
  ].join('\n');
}

// `impz info`'s https line: the domain, and whether the DNS API token file
// reads now. A token from the env has no check, and says nothing: only the
// provider can tell whether a token is good. No line from an impd before it.
export function formatHttps(info: SystemInfo['https']): string[][] {
  if (info === undefined) {
    return [];
  }

  if (info === null) {
    return [['https', 'off (IMP_DOMAIN unset)']];
  }

  const token = info.dnsToken;

  if (token === null) {
    return [['https', info.domain]];
  }

  const state = token.isOk
    ? 'DNS token file readable'
    : `ERROR: ${token.error ?? 'the DNS token file fails'}`;

  return [['https', `${info.domain}, ${state}`]];
}

// what `impz info` says an upgrade left: the imps whose next wake boots
// cold, and how many run each older part; an older impd does not count them
export function formatBootStatus(
  status: Readonly<SystemInfo['bootStatus']> | undefined,
  impdVersion: string,
): string {
  if (status === undefined) {
    return `unknown (impd ${impdVersion} predates it)`;
  }

  const notes: string[] = [];

  if (status.coldBoots > 0) {
    notes.push(`${String(status.coldBoots)} will boot cold`);
  }

  const { ipv6 = 0, ...parts } = status.outdated;

  const outdated = Object.entries(parts)
    .filter(([, count]) => count > 0)
    .map(([part, count]) => `${String(count)} ${part}`);

  if (outdated.length > 0) {
    notes.push(`outdated: ${outdated.join(', ')}`);
  }

  if (ipv6 > 0) {
    notes.push(`${String(ipv6)} with no IPv6 until a cold boot`);
  }

  return notes.length === 0 ? 'none' : notes.join('; ');
}

export function formatBackupRun(run: Readonly<BackupRun>): string {
  const lines = [
    `backup ${run.snapshotId.slice(0, 8)}: ${String(run.imps.length)} imps, ${String(Math.round(run.dataAddedBytes / 1_048_576))} MiB added in ${String(Math.round(run.durationMs / 1000))}s`,
    ...run.skipped.map((skip) => `left out ${skip.name}: ${skip.reason}`),
    ...(run.excluded ?? []).map((imp) => `not backed up ${imp.name}: ${imp.reason}`),
  ];

  return lines.join('\n');
}

export function formatSessions(sessions: readonly Readonly<Session>[]): string {
  return formatTable(
    ['NAME', 'STATE', 'ATTACHED', 'PID', 'SIZE', 'STARTED', 'COMMAND'],
    sessions.map((session) => [
      session.name,
      formatSessionState(session),
      session.attached ? 'yes' : 'no',
      String(session.pid),
      `${String(session.cols)}x${String(session.rows)}`,
      session.startedAt.toISOString(),
      session.argv.join(' '),
    ]),
  );
}

export function formatSessionLogs(logs: readonly SessionLog[]): string {
  return formatTable(
    ['SESSION', 'GENERATION', 'STATE', 'BYTES', 'OFFSETS', 'EXIT', 'STARTED'],
    logs.map((log) => [
      log.session,
      log.executionGeneration,
      formatLogState(log),
      String(log.bytes),
      `${String(log.logStart)}-${String(log.logEnd)}`,
      formatLogExit(log),
      log.startedAt.toISOString(),
    ]),
  );
}

function formatLogState(log: SessionLog): string {
  if (log.stopped !== undefined) {
    return `${log.state} (stopped: ${log.stopped})`;
  }

  return log.complete ? `${log.state} (complete)` : log.state;
}

function formatLogExit(log: SessionLog): string {
  if (log.exitCode === undefined) {
    return '-';
  }

  return log.exitCode === null ? 'signal' : String(log.exitCode);
}

function formatSessionState(session: Readonly<Session>): string {
  if (session.exit === undefined) {
    return session.state;
  }

  const how = session.exit.signal ?? `code ${String(session.exit.code)}`;

  return `exited (${how})`;
}

export function formatServices(services: readonly Readonly<Service>[]): string {
  return formatTable(
    ['NAME', 'STATE', 'PID', 'RESTARTS', 'LAST EXIT', 'COMMAND'],
    services.map((service) => [
      service.name,
      service.state,
      service.pid === null ? '-' : String(service.pid),
      String(service.restarts),
      formatLastExit(service.lastExit),
      service.argv.join(' '),
    ]),
  );
}

function formatLastExit(exit: Service['lastExit']): string {
  if (exit === null) {
    return '-';
  }

  return exit.signal ?? `code ${String(exit.code)}`;
}

export function formatImages(images: readonly Image[]): string {
  return formatTable(
    ['NAME', 'REF', 'DIGEST', 'SIZE'],
    images.map((image) => [
      image.name,
      image.ref,
      image.digest.slice(0, 19),
      `${String(Math.round(image.sizeBytes / 1_048_576))} MiB`,
    ]),
  );
}

// a build's start to the second, and its age at `nowMs`
export function formatImageBuilds(builds: readonly ImageBuildRun[], nowMs: number): string {
  return formatTable(
    ['NAME', 'SOURCE', 'STARTED', 'ELAPSED', 'PHASE', 'STEP', 'BUILDER'],
    builds.map((build) => [
      build.name,
      build.source,
      build.startedAt.toISOString().replace(/\.\d+Z$/v, 'Z'),
      formatDuration(Math.max(0, nowMs - build.startedAt.getTime())),
      build.phase,
      build.step ?? '-',
      build.builder ?? '-',
    ]),
  );
}

export function formatSecrets(secrets: readonly Secret[]): string {
  return formatTable(
    ['NAME', 'KIND', 'STATE', 'HOSTS', 'IMPS'],
    secrets.map((secret) => [
      secret.name,
      secret.kind,
      formatSecretState(secret),
      secret.rules
        .map((rule) =>
          rule.upstream === undefined ? rule.host : `${rule.host} -> ${rule.upstream}`,
        )
        .join(','),
      secret.imps.length === 0 ? '-' : secret.imps.join(','),
    ]),
  );
}

// `-` for a kind that never expires; for oauth, whether its access token is
// there and until when
function formatSecretState(secret: Readonly<Secret>): string {
  const oauth = secret.oauth;

  if (oauth === undefined) {
    return '-';
  }

  if (oauth.status === 'ready') {
    return oauth.expiresAt === null ? 'ready' : `ready until ${oauth.expiresAt.toISOString()}`;
  }

  if (oauth.status === 'pending') {
    return oauth.error === null ? 'pending' : `pending (${oauth.error})`;
  }

  return `needs_login (${oauth.error ?? 'unknown'})`;
}

export function formatNetworks(networks: readonly Network[]): string {
  return formatTable(
    ['NAME', 'IMPS'],
    networks.map((network) => [
      network.name,
      network.imps.length === 0 ? '-' : network.imps.join(','),
    ]),
  );
}

// a token or an identity as any impd answers: one from before grantable
// lists or image ref prefixes leaves the field out, and the client applies
// no schema default
type WithOptionalGrantable<T> = Omit<T, 'grantable' | 'imageRefPrefix'> & {
  readonly grantable?: readonly string[] | undefined;
  readonly imageRefPrefix?: string | null | undefined;
};

export function formatTokens(tokens: readonly WithOptionalGrantable<Token>[]): string {
  return formatTable(
    ['NAME', 'SCOPE', 'IMPS', 'GRANTABLE', 'IMAGE REF PREFIX', 'SSH KEYS', 'CREATED'],
    tokens.map((token) => [
      token.name,
      token.scope,
      token.imps === null ? '*' : token.imps.join(','),
      formatGrantable(token, '-'),
      token.imageRefPrefix ?? '-',
      String(token.sshKeys.length),
      token.createdAt.toISOString(),
    ]),
  );
}

export function formatOAuthClients(clients: readonly OAuthClient[]): string {
  return formatTable(
    ['NAME', 'CLIENT ID', 'REDIRECT URIS', 'CREATED'],
    clients.map((client) => [
      client.name,
      client.clientId,
      client.redirectUris.join(','),
      client.createdAt.toISOString(),
    ]),
  );
}

export function formatOAuthGrants(grants: readonly OAuthGrant[]): string {
  return formatTable(
    ['ID', 'CLIENT', 'TOKEN', 'SCOPE', 'IMPS', 'CREATED', 'LAST USED'],
    grants.map((grant) => [
      grant.id,
      grant.client,
      grant.token,
      grant.scope,
      grant.imps === null ? '*' : grant.imps.join(','),
      grant.createdAt.toISOString(),
      grant.lastUsedAt?.toISOString() ?? '-',
    ]),
  );
}

// what a sign-in asks for, for its approver to check before approving
export function formatOAuthApproval(approval: Readonly<OAuthApproval>): string {
  return [
    `client:       ${approval.client}`,
    `returns to:   ${approval.redirectUri}`,
    `asks for:     up to ${approval.requestedScope}`,
    `started:      ${approval.requestedAt.toISOString()}`,
    `ends:         ${approval.expiresAt.toISOString()}`,
  ].join('\n');
}

// `SHA256:... comment`, as `ssh-keygen -l` prints a key
export function formatSshKey(key: SshKey): string {
  return key.comment === '' ? key.fingerprint : `${key.fingerprint} ${key.comment}`;
}

export function formatIdentity(identity: WithOptionalGrantable<Identity>): string {
  const imps = identity.imps === null ? 'every imp' : identity.imps.join(',');
  const names = formatGrantable(identity, '');
  const grants = names === '' ? '' : `; may grant ${names}`;
  const prefix = identity.imageRefPrefix ?? null;
  const images = prefix === null ? '' : `; may add images from ${prefix}`;

  return `${identity.kind} ${identity.name}: ${identity.scope} on ${imps}${grants}${images}`;
}

// the secrets it may grant, comma-separated, or `none`
function formatGrantable(
  entry: Readonly<{ grantable?: readonly string[] | undefined }>,
  none: string,
): string {
  const names = entry.grantable ?? [];

  return names.length === 0 ? none : names.join(',');
}

export function formatAudit(entries: readonly AuditEntry[]): string {
  return formatTable(
    ['TIME', 'IMP', 'SECRET', 'METHOD', 'HOST', 'PATH', 'STATUS', 'BYTES', 'MS'],
    entries.map((entry) => [
      entry.at.toISOString(),
      entry.imp,
      entry.secret,
      entry.method,
      entry.host,
      entry.path,
      String(entry.status),
      `${String(entry.requestBytes)}/${String(entry.responseBytes)}`,
      String(entry.durationMs),
    ]),
  );
}

export function formatRefusedRequests(refused: readonly RefusedRequest[]): string {
  return formatTable(
    ['TIME', 'IMP', 'METHOD', 'HOST', 'PATH', 'STATUS', 'MS', 'REASON'],
    refused.map((entry) => [
      entry.at.toISOString(),
      entry.imp,
      entry.method ?? '-',
      entry.host ?? '-',
      entry.path ?? '-',
      String(entry.status),
      String(entry.durationMs),
      entry.reason,
    ]),
  );
}

// a list a filter leaves out allows any method or any path: `*`
export function formatGrants(grants: readonly Grant[]): string {
  return formatTable(
    ['SECRET', 'METHODS', 'PATHS'],
    grants.map((grant) => [
      grant.secret,
      grant.filter?.methods?.join(',') ?? '*',
      grant.filter?.paths?.join(',') ?? '*',
    ]),
  );
}

export function formatApiCalls(calls: readonly ApiCall[]): string {
  return formatTable(
    ['TIME', 'IMP', 'PROCEDURE', 'ACTOR', 'OUTCOME', 'MS', 'DETAIL'],
    calls.map((call) => [
      call.at.toISOString(),
      call.imp ?? '-',
      call.procedure,
      call.actorName === undefined ? call.actor : `${call.actor} ${call.actorName}`,
      call.outcome,
      String(call.durationMs),
      call.detail ?? '-',
    ]),
  );
}

// what went, or would go, then the orphans it kept
export function formatGc(gc: Readonly<StorageGc>): string {
  const kept = gc.kept ?? [];

  const removed =
    gc.dropped.length === 0
      ? 'nothing to remove'
      : formatTable(
          ['KIND', 'ID'],
          gc.dropped.map((dropped) => [dropped.kind, dropped.id]),
        );

  const lines = [
    gc.dryRun && gc.dropped.length > 0 ? `${removed}\n(dry run: nothing removed)` : removed,
  ];

  if (kept.length > 0) {
    lines.push(
      `\nkept ${String(kept.length)} orphans the database does not name; \`impz gc --orphans\` retires them:`,
      formatTable(
        ['KIND', 'ID', 'LOCATION', 'SIZE', 'CREATED', 'SNAPSHOTS'],
        kept.map((orphan) => [
          orphan.kind,
          orphan.id,
          orphan.location,
          formatBytes(orphan.bytes),
          orphan.createdAt?.toISOString() ?? '-',
          formatOrphanContents(orphan),
        ]),
      ),
    );
  }

  return lines.join('\n');
}

// its snapshots, or for kept secret values how many files
function formatOrphanContents(orphan: Readonly<OrphanStorage>): string {
  if (orphan.files !== undefined) {
    return `${String(orphan.files.length)} files`;
  }

  return orphan.snapshots.length === 0 ? '-' : orphan.snapshots.join(',');
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// what a command prints: JSON with --json, else its table
export function formatOutput<T>(
  value: T,
  json: boolean | undefined,
  formatText: (value: T) => string,
): string {
  return json === true ? formatJson(value) : formatText(value);
}
