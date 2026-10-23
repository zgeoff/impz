import { rmSync } from 'node:fs';

export function removeFile(path: string): void {
  rmSync(path, { force: true });
}
