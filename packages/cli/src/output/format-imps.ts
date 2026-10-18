import type { ExposeResult, Imp } from '@impz/api';
import { formatBytes, formatMib } from '@impz/shared';
import { formatTable } from './format-output';
import type { Row } from './format-output';

const IMP_HEADER = [
  'NAME',
  'STATE',
  'IMAGE',
  'VCPUS',
  'MEMORY',
  'RAM',
  'DISK',
  'USED',
  'SHARED',
  'CPU',
  'SESSIONS',
  'IP',
  'URL',
  'NOTE',
] as const;

export function formatImps(imps: readonly Imp[]): string {
  return formatTable(
    IMP_HEADER,
    imps.map((imp) => toImpRow(imp)),
  );
}

// `impz ls --all`: the saved host first, then the columns of `impz ls`
export function formatHostImps(imps: readonly (Imp & { readonly host: string })[]): string {
  return formatTable(
    ['HOST', ...IMP_HEADER],
    imps.map((imp) => [imp.host, ...toImpRow(imp)]),
  );
}

function toImpRow(imp: Imp): Row {
  return [
    imp.name,
    imp.state,
    imp.image,
    String(imp.vcpus),
    formatMemory(imp),
    imp.ramMib === undefined ? '-' : `${String(imp.ramMib)} MiB`,
    formatMib(imp.diskMib),
    ...formatDiskUsage(imp.diskUsage),
    formatCpuUse(imp),
    imp.sessions === undefined ? '-' : String(imp.sessions),
    imp.ip,
    imp.url,
    formatNote(imp),
  ];
}

// an elastic imp's size now and its max: `768/1024 MiB`
function formatMemory(imp: Imp): string {
  if (imp.maxMemoryMib === undefined) {
    return `${String(imp.memoryMib)} MiB`;
  }

  const nowMib = imp.memoryMib + (imp.pluggedMib ?? 0);

  return `${String(nowMib)}/${String(imp.maxMemoryMib)} MiB`;
}

// what a destroy frees, and what the imp shares; `<=` when a fork holds a
// snapshot of it, `?` when the last pass was cut short
function formatDiskUsage(usage: Imp['diskUsage']): [string, string] {
  if (usage === undefined) {
    return ['-', '-'];
  }

  const bound = usage.isUpperBound ? '<=' : '';
  const partial = usage.isPartial ? '?' : '';

  return [
    `${bound}${formatBytes(usage.exclusiveBytes)}${partial}`,
    `${formatBytes(usage.sharedBytes)}${partial}`,
  ];
}

// what the imp's storage takes over its disk size, as `impz top` shows it:
// `<=1.2 GiB / 32.0 GiB`
export function formatDiskUse(imp: Imp): string {
  const [used] = formatDiskUsage(imp.diskUsage);

  return `${used} / ${formatMib(imp.diskMib)}`;
}

// the last sample's CPU, in percent of one core, over the limit when there is
// one: `45% / 1.5`
export function formatCpuUse(imp: Imp): string {
  const percent = imp.resources?.sample?.cpuPercent;
  const used = percent === undefined ? '-' : `${percent.toFixed(0)}%`;
  const limit = imp.cpu?.limit ?? null;

  return limit === null ? used : `${used} / ${String(limit)}`;
}

// what an upgrade means for the imp (docs/guides/operations.md#upgrade), and
// an agent the watchdog reports silent
function formatNote(imp: Imp): string {
  const notes: string[] = [];

  // first: during a move the imp shows on both hosts, and this says which
  // side each row is (docs/guides/hosts.md#one-view)
  if (imp.move !== undefined) {
    notes.push(imp.move);
  }

  // impd's, for one image build (docs/guides/images.md#isolated-builds)
  if (imp.kind === 'builder') {
    notes.push('image builder');
  }

  if (imp.agentSilentSince !== undefined) {
    notes.push(`agent silent since ${imp.agentSilentSince.toISOString()}`);
  }

  // the agent answers, but nothing of the imp's own runs (impz info has why)
  if (imp.inner?.up === false) {
    notes.push('container down');
  }

  if (imp.public !== undefined) {
    const auth = imp.public.auth === 'none' ? '' : ` (${imp.public.auth})`;

    notes.push(`public${auth}`);
  }

  if (imp.coldBootReason !== undefined) {
    const when = imp.state === 'sleeping' ? 'boots cold' : 'booted cold';

    notes.push(`${when}: ${imp.coldBootReason}`);
  }

  const outdated = imp.outdated ?? [];
  const parts = outdated.filter((part) => part !== 'impd' && part !== 'ipv6');

  if (outdated.includes('impd')) {
    notes.push('booted by an older impd; its next wake boots cold');
  }

  if (parts.length > 0) {
    notes.push(`outdated: ${parts.join(', ')}`);
  }

  if (outdated.includes('ipv6')) {
    notes.push('no IPv6 until its next cold boot');
  }

  return notes.join('; ');
}

// What an expose made, the credential included: impd shows it this once
export function formatExposeResult(result: ExposeResult): string {
  const lines = [`${result.url} is public`];

  if (result.auth === 'token') {
    lines.push(`token: ${result.credential ?? ''}`);
  }

  if (result.auth === 'basic') {
    lines.push(`user: ${result.user ?? ''}`, `password: ${result.credential ?? ''}`);
  }

  if (result.credential !== null) {
    lines.push('impd keeps only a hash; expose the imp again for a new one.');
  }

  if (result.warning !== undefined) {
    lines.push(`warning: ${result.warning}`);
  }

  return lines.join('\n');
}

export function formatImp(imp: Imp): string {
  return formatImps([imp]);
}

// `impz info <name>`: one imp, a field a line, with its inner container's
// state, restarts and last error
export function formatImpInfo(imp: Imp): string {
  const inner = imp.inner;
  const note = formatNote(imp);

  const lines = [
    ['name', imp.name],
    ['state', imp.state],
    ['image', imp.image],
    ['ip', imp.ip],
    ['url', imp.url],
    ['container', formatContainer(imp)],
    ...(inner === undefined ? [] : [['restarts', String(inner.restarts)]]),
    ...(inner?.lastError === undefined ? [] : [['last error', inner.lastError]]),
    ...(note === '' ? [] : [['note', note]]),
  ];

  return lines.map(([label = '', value = '']) => `${label.padEnd(12)}${value}`).join('\n');
}

// the inner container, where the imp's processes run: known only while the
// imp is awake and its agent answers
function formatContainer(imp: Imp): string {
  if (imp.state !== 'running') {
    return 'not running';
  }

  if (imp.inner === undefined) {
    return 'unknown';
  }

  return imp.inner.up ? 'up' : 'down';
}
