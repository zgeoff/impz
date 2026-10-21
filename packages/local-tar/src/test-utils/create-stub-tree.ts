import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function createStubTree(
  root: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}
