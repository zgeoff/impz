export interface AsleepLine {
  readonly durationMs: number;

  // what stayed plugged through the sleep; null for an imp without elastic memory
  readonly pluggedMib: number | null;

  // the milliseconds of each step the line ends with, as `pause=3ms`
  readonly steps: Readonly<Record<string, number>>;
}

// The newest `impd: <name>: asleep in` line in an impd log (make-sleep-imp-vm.ts
// logs one per sleep), or null when the log holds none for that imp.
export function findAsleepLine(log: string, name: string): AsleepLine | null {
  const line = log
    .split('\n')
    .findLast((candidate) => candidate.includes(`impd: ${name}: asleep in `));

  if (line === undefined) {
    return null;
  }

  const durationMs = /: asleep in (?<ms>\d+)ms /v.exec(line)?.groups?.['ms'];
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
