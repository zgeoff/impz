import { appendFileSync } from 'node:fs';

export function writeStepValues(path: string, values: Readonly<Record<string, string>>): void {
  appendFileSync(
    path,
    Object.entries(values)
      .map(([name, value]) => `${name}=${value}\n`)
      .join(''),
  );
}
