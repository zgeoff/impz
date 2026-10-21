import { runChecked } from '../../platform/process/run-command';

export async function createReflinkClone(source: string, target: string): Promise<void> {
  // cp refuses --sparse beside --reflink=always, and the shared extents keep the holes anyway
  await runChecked(['cp', '--reflink=always', source, target]);
}
