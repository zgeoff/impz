import { readFileSync } from 'node:fs';

export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}
