import { join } from 'node:path';
import { parseHostArgs } from '../render/render-imp-host.ts';
import { DevError } from './dev-error.ts';

export function readProxyPrivileges(
  readText: (path: string) => string | null,
  root: string,
): string[] {
  const file = join(root, 'deploy', 'imp-host.args.json');
  const text = readText(file);

  if (text === null) {
    throw new DevError(`cannot read ${file}`);
  }

  return parseHostArgs(text).proxy.privileges.flat();
}
