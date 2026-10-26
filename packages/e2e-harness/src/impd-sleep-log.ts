export interface AsleepLine {
  readonly durationMs: number;

  readonly pluggedMib: number | null;

  readonly steps: Readonly<Record<string, number>>;
}

export function findAsleepLine(log: string, name: string): AsleepLine | null {
  const line = log
    .split('\n')
    .findLast((candidate) => candidate.includes(`impd.imps imp=${name} asleep in `));

  if (line === undefined) {
    return null;
  }

  const durationMs = / asleep in (?<ms>\d+)ms /v.exec(line)?.groups?.['ms'];
  const plugged = /, (?<plugged>\d+) MiB plugged,/v.exec(line)?.groups?.['plugged'];

  if (durationMs === undefined) {
    throw new Error(`no duration in ${JSON.stringify(line)}`);
  }

  const steps = Object.fromEntries(
    [...line.matchAll(/ (?<step>\w+)=(?<stepMs>\d+)ms/gv)].map((match) => [
      match.groups?.['step'] ?? '',
      Number(match.groups?.['stepMs']),
    ]),
  );

  return {
    durationMs: Number(durationMs),
    pluggedMib: plugged === undefined ? null : Number(plugged),
    steps,
  };
}
