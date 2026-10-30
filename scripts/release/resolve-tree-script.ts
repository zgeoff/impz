import { existsSync } from 'node:fs';
import { join } from 'node:path';

// A republish checks out an old tag, and a tag from before scripts/release/ keeps each release
// script in scripts/ or host/.
const scriptFolders = ['scripts/release', 'scripts', 'host'];

export function resolveTreeScript(tree: string, name: string): string | null {
  const folder = scriptFolders.find((candidate) => existsSync(join(tree, candidate, name)));

  return folder === undefined ? null : join(folder, name);
}
