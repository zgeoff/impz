export function getU32Span(left: number, right: number): number {
  const span = Math.abs(left - right);

  return Math.min(span, 2 ** 32 - span);
}

// impd ends a boot line with sections such as `; guest …` and `; host stall …`.
const SECTION_MARK = '; ';
const GUEST_LABEL = 'guest ';

export function parseLoggedSteps(
  log: string,
  name: string,
  what: string,
): Readonly<Record<string, number>> {
  const line = findLoggedLine(log, name, what);

  if (line === undefined) {
    return {};
  }

  const [host = ''] = line.split(SECTION_MARK);
  const steps = parseStepPairs(host);
  const total = /created in (?<ms>\d+)ms/v.exec(host)?.groups?.['ms'];

  return total === undefined ? steps : { ...steps, total: Number(total) };
}

export function parseLoggedGuestSteps(
  log: string,
  name: string,
  what: string,
): Readonly<Record<string, number>> {
  const sections = findLoggedLine(log, name, what)?.split(SECTION_MARK) ?? [];
  const guest = sections.find((section) => section.startsWith(GUEST_LABEL)) ?? '';

  return parseStepPairs(guest);
}

export function pickPercentile(values: readonly number[], fraction: number): number {
  const sorted = values.toSorted((left, right) => left - right);

  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
}

function findLoggedLine(log: string, name: string, what: string): string | undefined {
  return log.split('\n').findLast((candidate) => candidate.includes(`imp=${name} ${what}`));
}

function parseStepPairs(text: string): Readonly<Record<string, number>> {
  return Object.fromEntries(
    Array.from(text.matchAll(/(?<step>\w+)=(?<ms>\d+)ms/gv), (match) => [
      match.groups?.['step'] ?? '',
      Number(match.groups?.['ms']),
    ]),
  );
}
