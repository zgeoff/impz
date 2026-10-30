import { join } from 'node:path';

// A republish checks out an old tag, and a tag from before scripts/release/ keeps each release
// script in scripts/ or host/.
const scriptFolders = ['scripts/release', 'scripts', 'host'];

export function findTreeScript(name: string, hasFile: (path: string) => boolean): string | null {
  const folder = scriptFolders.find((candidate) => hasFile(join(candidate, name)));

  return folder === undefined ? null : join(folder, name);
}
