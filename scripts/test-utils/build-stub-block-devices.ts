import { formatShellWord } from '@impz/test-utils/format-shell-word';

interface StubBlockDevice {
  readonly type?: string;
  readonly label?: string;
  readonly signature?: boolean;
  readonly mountpoints?: readonly string[];
  readonly partitions?: readonly string[];
}

interface StubBlockDevices {
  readonly root: { readonly source: string; readonly disk: string };
  readonly devices: Readonly<Record<string, StubBlockDevice>>;
}

export interface StubBlockDeviceScripts {
  readonly stat: string;
  readonly findmnt: string;
  readonly lsblk: string;
  readonly blkid: string;
}

export function buildStubBlockDevices(stub: StubBlockDevices): StubBlockDeviceScripts {
  const entries = Object.entries(stub.devices);
  const blockPaths = [stub.root.source, stub.root.disk, ...entries.map(([path]) => path)];

  const stat = `case "$*" in
${blockPaths.map((path) => `  "-L -c %F "${formatShellWord(path)}) echo 'block special file' ;;`).join('\n')}
  "-L -c %F "*) echo "stat: cannot statx '\${*: -1}': No such file or directory" >&2; exit 1 ;;
  *) echo "unexpected: stat $*" >&2; exit 1 ;;
esac`;

  const findmnt = `case "$*" in
  "-n -o SOURCE /") echo ${formatShellWord(stub.root.source)} ;;
  *) echo "unexpected: findmnt $*" >&2; exit 1 ;;
esac`;

  const lsblk = `case "$*" in
  "-n -s -o PATH "${formatShellWord(stub.root.source)}) ${buildPrintLines([stub.root.source, stub.root.disk])} ;;
${entries
  .map(
    ([path, device]) =>
      `  "-n -o MOUNTPOINTS "${formatShellWord(path)}) ${buildPrintLines(device.mountpoints ?? [''])} ;;\n` +
      `  "-n -o PATH "${formatShellWord(path)}) ${buildPrintLines([path, ...(device.partitions ?? [])])} ;;`,
  )
  .join('\n')}
  *) echo "unexpected: lsblk $*" >&2; exit 1 ;;
esac`;

  const blkid = `case "$*" in
${entries
  .map(
    ([path, device]) =>
      `  "-p -s TYPE -o value "${formatShellWord(path)}) ${device.type === undefined ? 'exit 2' : `echo ${formatShellWord(device.type)}`} ;;\n` +
      `  "-p -s LABEL -o value "${formatShellWord(path)}) ${device.label === undefined ? 'exit 2' : `echo ${formatShellWord(device.label)}`} ;;\n` +
      `  "-p "${formatShellWord(path)}) ${buildBlkidProbe(path, device)} ;;`,
  )
  .join('\n')}
  *) echo "unexpected: blkid $*" >&2; exit 4 ;;
esac`;

  return { stat, findmnt, lsblk, blkid };
}

function buildPrintLines(lines: readonly string[]): string {
  return `printf '%s\\n' ${lines.map((line) => formatShellWord(line)).join(' ')}`;
}

function buildBlkidProbe(path: string, device: StubBlockDevice): string {
  if (device.type !== undefined) {
    return `echo ${formatShellWord(`${path}: TYPE="${device.type}"`)}`;
  }

  return device.signature === true ? `echo ${formatShellWord(`${path}: PTTYPE="gpt"`)}` : 'exit 2';
}
