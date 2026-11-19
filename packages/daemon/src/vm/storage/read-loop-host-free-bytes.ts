import { readFileSync, realpathSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LoopHostDirs {
  readonly procDir: string;
  readonly sysDir: string;
}

const HOST_DIRS: LoopHostDirs = { procDir: '/proc', sysDir: '/sys' };

/* @internal */
export function readLoopBackingFile(
  directory: string,
  hostDirs: Readonly<LoopHostDirs> = HOST_DIRS,
): string | null {
  try {
    const target = realpathSync(directory);
    const mountInfo = readFileSync(join(hostDirs.procDir, 'self', 'mountinfo'), 'utf8');

    for (const line of mountInfo.split('\n')) {
      // <id> <parent> <dev> <root> <mount point> ... - <fstype> <source> ...
      const [mounts = '', fields = ''] = line.split(' - ');
      const mountPoint = mounts.split(' ').at(4);
      const [, source = ''] = fields.split(' ');
      const loop = /^\/dev\/(?<name>loop\d+)$/u.exec(source)?.groups?.['name'];

      if (mountPoint === target && loop !== undefined) {
        const backing = join(hostDirs.sysDir, 'block', loop, 'loop', 'backing_file');

        return readFileSync(backing, 'utf8').trim();
      }
    }
  } catch {
    // no mountinfo or sysfs: the filesystem's own count stands
  }

  return null;
}

// a filesystem on a sparse loop file can report room that its backing file can no longer get
export function readLoopHostFreeBytes(
  directory: string,
  hostDirs: Readonly<LoopHostDirs> = HOST_DIRS,
): number | null {
  const backing = readLoopBackingFile(directory, hostDirs);

  if (backing === null) {
    return null;
  }

  try {
    const host = statfsSync(dirname(backing));

    return host.bavail * host.bsize;
  } catch {
    return null;
  }
}
