import { join } from 'node:path';
import type { $, ShellExpression } from 'bun';
import type { DevCheckout } from './read-dev-checkout.ts';

type HostImageShell = (
  strings: TemplateStringsArray,
  ...expressions: ShellExpression[]
) => $.ShellPromise;

// No provenance: its build timestamp would give each rebuild of an unchanged tree a new image id.
export async function createHostImage(
  shell: HostImageShell,
  checkout: DevCheckout,
  machineID: string,
): Promise<void> {
  // Without a machine id, no machine label: prune never touches the image.
  const labels = [
    '--label',
    `imp.worktree=${checkout.rootPhysical}`,
    ...(machineID === '' ? [] : ['--label', `imp.machine=${machineID}`]),
  ];

  await shell`docker build -q --provenance=false -t ${checkout.hostImage} ${labels} --target dev -f ${join(checkout.root, 'host', 'Dockerfile')} ${checkout.root} > /dev/null`;
}
