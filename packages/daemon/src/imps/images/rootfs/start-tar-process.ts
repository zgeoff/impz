import type { TarProcess } from './write-streamed-tree';

// LC_ALL=C keeps tar's listing and warnings in English, the form their parsers read.
export function startTarProcess(argv: readonly string[]): TarProcess {
  return Bun.spawn([...argv], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, LC_ALL: 'C' },
  });
}
