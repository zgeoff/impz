// The distance between two u32 values, around the wrap: how far apart two
// guests' TCP ISN secrets lie.
export function findU32Span(a: number, b: number): number {
  const span = Math.abs(a - b);

  return Math.min(span, 2 ** 32 - span);
}

// what parts impd's steps from the guest's in a boot line
const GUEST_MARK = '; guest ';

// The `step=12ms` pairs of the last impd log line that names the imp and
// `what`, with `total` from a `created in 40ms`; empty when no line matches.
// The guest's own steps after `; guest ` are not impd's, and stay out.
export function parseLoggedSteps(
  log: string,
  name: string,
  what: string,
): Readonly<Record<string, number>> {
  const line = findLoggedLine(log, name, what);

  if (line === undefined) {
    return {};
  }

  const [host = ''] = line.split(GUEST_MARK);
  const steps = parseStepPairs(host);
  const total = /created in (?<ms>\d+)ms/v.exec(host)?.groups?.['ms'];

  return total === undefined ? steps : { ...steps, total: Number(total) };
}

// The guest's own `step=12ms` pairs, after `; guest `, of the last impd log
// line that names the imp and `what`; empty when no line matches or the
// line has none.
export function parseLoggedGuestSteps(
  log: string,
  name: string,
  what: string,
): Readonly<Record<string, number>> {
  const [, guest = ''] = findLoggedLine(log, name, what)?.split(GUEST_MARK) ?? [];

  return parseStepPairs(guest);
}

// the nearest-rank percentile, 0 for no values
export function pickPercentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function findLoggedLine(log: string, name: string, what: string): string | undefined {
  return log.split('\n').findLast((candidate) => candidate.includes(`${name}: ${what}`));
}

function parseStepPairs(text: string): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Array.from(text.matchAll(/(?<step>\w+)=(?<ms>\d+)ms/gv), (match) => [
      match.groups?.['step'] ?? '',
      Number(match.groups?.['ms']),
    ]),
  );
}
