import { join } from 'node:path';
import { parseHostArgs } from '../render/render-imp-host.ts';
import { DevError } from './dev-error.ts';

interface HostPrivilegeFiles {
  readonly readText: (path: string) => string | null;
  readonly probePath: (path: string) => boolean;
}

const DEPLOYED_SECCOMP = 'seccomp=/etc/imp/imp-host.seccomp.json';

// The repo's own seccomp profile stands in for the deployed copy in /etc/imp.
export function readHostPrivileges(
  files: HostPrivilegeFiles,
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const file = join(root, 'deploy', 'imp-host.args.json');
  const text = files.readText(file);

  if (text === null) {
    throw new DevError(`cannot read ${file}`);
  }

  const args = parseHostArgs(text);
  const seccomp = `seccomp=${join(root, 'deploy', 'imp-host.seccomp.json')}`;

  return [
    ...args.privileges.flat().map((word) => (word === DEPLOYED_SECCOMP ? seccomp : word)),
    ...args.probed
      .filter(
        (probed) =>
          files.probePath(probed.path) &&
          (probed.setting === undefined || env[probed.setting.name] === probed.setting.value),
      )
      .flatMap((probed) => probed.args),
  ];
}
