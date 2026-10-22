import { statSync } from 'node:fs';
import { $ } from 'bun';
import { buildDevImageTag } from '../lib/build-dev-image-tag.ts';
import { DevError } from '../lib/dev-error.ts';
import { readMachineID } from '../lib/read-machine-id.ts';
import type { Dev } from './types.ts';

// Only images labelled on this machine are touched, never another project's or another machine's,
// and only the checkout's own tag, so an override tag or a second tag keeps the image. Images of
// live checkouts stay as build caches.
export async function pruneDevImages(dev: Dev): Promise<void> {
  const machineID = readMachineID(dev.env);

  if (machineID.id === '') {
    throw new DevError(`prune needs a machine id in ${machineID.file}`);
  }

  const format = '{{.Repository}}:{{.Tag}} {{.ID}}';

  const listed = await $`docker image ls --filter label=imp.worktree --format ${format}`.text();

  const entries = listed.split('\n').filter((entry) => entry !== '' && !entry.includes('<none>'));

  for (const entry of entries) {
    const [ref = '', id = ''] = entry.split(' ');

    const verdict = await pruneImage({ ref, id, machine: machineID.id });

    if (verdict !== null) {
      console.log(verdict);
    }
  }

  const machineLabel = `label=imp.machine=${machineID.id}`;

  await $`docker image prune -f --filter label=imp.worktree --filter ${machineLabel}`;
}

interface ListedImage {
  readonly ref: string;
  readonly id: string;
  readonly machine: string;
}

async function pruneImage(image: ListedImage): Promise<string | null> {
  const format =
    '{{index .Config.Labels "imp.worktree"}}{{"\t"}}{{index .Config.Labels "imp.machine"}}';

  const inspect = await $`docker image inspect -f ${format} ${image.id}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    return `dev.sh: keeping ${image.ref}: docker image inspect failed`;
  }

  const [directory = '', from = ''] = inspect.stdout.toString().replace(/\n$/u, '').split('\t');

  // An empty label names no checkout, so it cannot be gone.
  if (directory === '' || probeDirectory(directory) || from !== image.machine) {
    return null;
  }

  if (image.ref !== buildDevImageTag(directory)) {
    return `dev.sh: keeping ${image.ref}: not the tag of ${directory}`;
  }

  const ancestor = `ancestor=${image.id}`;

  const users = await $`docker ps -aq --filter ${ancestor}`.quiet().nothrow();

  if (users.stdout.toString().trim() !== '') {
    return `dev.sh: keeping ${image.ref}: a container uses it`;
  }

  const removed = await $`docker image rm ${image.ref} > /dev/null`.nothrow();

  if (removed.exitCode !== 0) {
    return `dev.sh: keeping ${image.ref}: docker image rm failed`;
  }

  return `dev.sh: removed ${image.ref} (${directory} is gone)`;
}

function probeDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
