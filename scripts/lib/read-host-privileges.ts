import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostArgs } from '../render/render-imp-host.ts';

const DEPLOYED_SECCOMP = 'seccomp=/etc/imp/imp-host.seccomp.json';

// The repo's own seccomp profile stands in for the deployed copy in /etc/imp.
export function readHostPrivileges(root: string): string[] {
  const args = parseHostArgs(readFileSync(join(root, 'deploy', 'imp-host.args.json'), 'utf8'));
  const seccomp = `seccomp=${join(root, 'deploy', 'imp-host.seccomp.json')}`;

  return [
    ...args.privileges.flat().map((word) => (word === DEPLOYED_SECCOMP ? seccomp : word)),
    ...args.probed.filter((probed) => existsSync(probed.path)).flatMap((probed) => probed.args),
  ];
}
