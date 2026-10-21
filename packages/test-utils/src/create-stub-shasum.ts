import { chmodSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface StubShasumOptions {
  readonly bin: string;
}

export interface StubShasum {
  readonly readCalls: () => readonly string[];
}

export function createStubShasum(options: StubShasumOptions): StubShasum {
  const sha256sum = Bun.which('sha256sum', { PATH: process.env['PATH'] ?? '' });

  if (sha256sum === null) {
    throw new Error('sha256sum is not on PATH');
  }

  const log = join(options.bin, 'shasum.calls');

  writeFileSync(log, '');
  writeFileSync(join(options.bin, 'shasum.sha256sum'), `${sha256sum}\n`);
  copyFileSync(join(import.meta.dir, 'run-stub-shasum.sh'), join(options.bin, 'shasum'));
  chmodSync(join(options.bin, 'shasum'), 0o755);

  return {
    readCalls: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== ''),
  };
}
