import { DevError } from '../lib/dev-error.ts';
import { readMachineID } from '../lib/read-machine-id.ts';
import { pickImageRetention } from './pick-image-retention.ts';
import type { ImageLabels, ImageObservation } from './pick-image-retention.ts';
import type { Dev } from './types.ts';

export async function pruneDevImages(dev: Dev): Promise<void> {
  const machineID = readMachineID(dev.io.files.readText, dev.env);

  if (machineID.id === '') {
    throw new DevError(`prune needs a machine id in ${machineID.file}`);
  }

  const format = '{{.Repository}}:{{.Tag}} {{.ID}}';

  const listed = await dev.io.shell`docker image ls --filter label=imp.worktree --format ${format}`
    .quiet()
    .nothrow();

  if (listed.exitCode !== 0) {
    throw new DevError('docker image ls failed', listed.stderr.toString());
  }

  const entries = listed.stdout
    .toString()
    .split('\n')
    .filter((entry) => entry !== '' && !entry.includes('<none>'));

  for (const entry of entries) {
    const [ref = '', id = ''] = entry.split(' ');

    const image = await readImageObservation(dev, ref, id);

    const retention = pickImageRetention(image, machineID.id);

    if (retention.kind === 'keep') {
      dev.io.writeStdout(`dev.sh: keeping ${ref}: ${retention.reason}`);
    }

    if (retention.kind === 'remove') {
      const removed = await dev.io.shell`docker image rm ${ref} > /dev/null`.nothrow();

      const verdict =
        removed.exitCode === 0
          ? `dev.sh: removed ${ref} (${image.labels?.worktree ?? ''} is gone)`
          : `dev.sh: keeping ${ref}: docker image rm failed`;

      dev.io.writeStdout(verdict);
    }
  }

  const machineLabel = `label=imp.machine=${machineID.id}`;

  await dev.io.shell`docker image prune -f --filter label=imp.worktree --filter ${machineLabel}`;
}

async function readImageObservation(dev: Dev, ref: string, id: string): Promise<ImageObservation> {
  const labels = await readImageLabels(dev, id);

  const ancestor = `ancestor=${id}`;

  const users = await dev.io.shell`docker ps -aq --filter ${ancestor}`.quiet().nothrow();

  return {
    ref,
    labels,
    isCheckoutLive: labels !== null && dev.io.files.probeDirectory(labels.worktree),
    isInUse: users.stdout.toString().trim() !== '',
  };
}

async function readImageLabels(dev: Dev, id: string): Promise<ImageLabels | null> {
  const format =
    '{{index .Config.Labels "imp.worktree"}}{{"\t"}}{{index .Config.Labels "imp.machine"}}';

  const inspect = await dev.io.shell`docker image inspect -f ${format} ${id}`.quiet().nothrow();

  if (inspect.exitCode !== 0) {
    return null;
  }

  const [worktree = '', machine = ''] = inspect.stdout.toString().replace(/\n$/u, '').split('\t');

  return { worktree, machine };
}
