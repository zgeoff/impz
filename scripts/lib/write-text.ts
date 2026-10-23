import { writeFileSync } from 'node:fs';

export function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}
