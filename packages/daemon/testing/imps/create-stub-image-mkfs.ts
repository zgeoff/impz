import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '@impz/test-utils/wait-for';

export function createStubImageMkfs(directory: string) {
  const bin = join(directory, 'bin');
  const started = join(directory, 'mkfs-started');
  const released = join(directory, 'mkfs-released');

  // the real mkfs.ext4 sits in sbin on most hosts
  const real =
    Bun.which('mkfs.ext4', { PATH: `${process.env['PATH'] ?? ''}:/usr/sbin:/sbin` }) ?? 'mkfs.ext4';

  const script = [
    '#!/bin/sh',
    `touch '${started}'`,
    `while [ ! -e '${released}' ]; do [ -d '${directory}' ] || exit 1; sleep 0.05; done`,
    `[ -s '${released}' ] && { cat '${released}' >&2; exit 1; }`,
    `exec '${real}' "$@"`,
    '',
  ].join('\n');

  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'mkfs.ext4'), script);
  chmodSync(join(bin, 'mkfs.ext4'), 0o755);

  return {
    bin,

    waitForStart: () =>
      waitFor(() => {
        if (!existsSync(started)) {
          throw new Error('mkfs.ext4 has not started');
        }
      }),
    release: () => {
      writeFileSync(released, '');
    },
    fail: (stderr: string) => {
      // the script polls for the file, so it must never see it empty before the text lands
      writeFileSync(`${released}.tmp`, `${stderr}\n`);
      renameSync(`${released}.tmp`, released);
    },
  };
}
