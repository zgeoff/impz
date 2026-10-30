import { join } from 'node:path';

export interface LogCollectionFacts {
  readonly engine: string;
  readonly container: string;
  readonly owner: string;
  readonly logsDir: string;
  readonly zfsDir: string | null;
  readonly dataDir: string | null;
  readonly zfsDirFiles: readonly string[];
}

export interface LogCollectionPlan {
  readonly prepareCommands: readonly (readonly string[])[];
  readonly copies: readonly { readonly from: string; readonly to: string }[];
  readonly logsCommand: readonly string[];
  readonly diskCommands: readonly (readonly string[])[];
}

const zfsLogFiles = ['impd.log', 'e2e.log', 'summary.txt'];

export function pickLogCollection(facts: LogCollectionFacts): LogCollectionPlan {
  const isPodman = facts.engine === 'podman';
  const zfsDir = facts.zfsDir;

  // the Podman proof runs as root and leaves root's files in the logs folder
  const prepareCommands = isPodman
    ? [
        ['sudo', 'mkdir', '-p', facts.logsDir],
        ['sudo', 'chown', '-R', facts.owner, facts.logsDir],
      ]
    : [];

  // the zfs host test keeps its logs and summary in its work dir
  const copies =
    zfsDir === null
      ? []
      : zfsLogFiles
          .filter((name) => facts.zfsDirFiles.includes(name))
          .map((name) => ({ from: join(zfsDir, name), to: join(facts.logsDir, name) }));

  // rootful Podman's containers are root's to read
  const logsCommand = isPodman
    ? ['sudo', 'podman', 'logs', facts.container]
    : ['docker', 'logs', facts.container];

  const diskCommands = [
    ...(facts.dataDir === null ? [] : [['du', '-h', join(facts.dataDir, 'imp.xfs')]]),
    ['df', '-h', '/', '/mnt'],
  ];

  return { prepareCommands, copies, logsCommand, diskCommands };
}
