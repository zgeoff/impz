import { readFileSync } from 'node:fs';

export interface MountEntry {
  readonly source: string;
  readonly target: string;
  readonly fstype: string;
}

export interface MountInfoEntry {
  readonly mountPoint: string;
  readonly fstype: string;
  readonly source: string;
}

export function readMounts(): string {
  return readFileSync('/proc/self/mounts', 'utf8');
}

export function parseMounts(mounts: string): MountEntry[] {
  return mounts
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [source = '', target = '', fstype = ''] = line.split(' ');

      return { source: decodeMountField(source), target: decodeMountField(target), fstype };
    });
}

// <id> <parent> <dev> <root> <mount point> <options> [<optional>...] - <fstype> <source> ...
export function parseMountInfo(mountInfo: string): MountInfoEntry[] {
  return mountInfo
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [mounts = '', fields = ''] = line.split(' - ');
      const [fstype = '', source = ''] = fields.split(' ');

      return {
        mountPoint: decodeMountField(mounts.split(' ').at(4) ?? ''),
        fstype,
        source: decodeMountField(source),
      };
    });
}

function decodeMountField(field: string): string {
  return field.replaceAll(/\\(?<octal>[0-7]{3})/gu, (_match, octal: string) =>
    String.fromCodePoint(Number.parseInt(octal, 8)),
  );
}
