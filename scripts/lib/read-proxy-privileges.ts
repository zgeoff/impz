import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostArgs } from '../render/render-imp-host.ts';

export function readProxyPrivileges(root: string): string[] {
  const args = parseHostArgs(readFileSync(join(root, 'deploy', 'imp-host.args.json'), 'utf8'));

  return args.proxy.privileges.flat();
}
