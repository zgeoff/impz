import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

interface CreateCommandLinksOptions {
  readonly bin: string;
  readonly names: readonly string[];
}

export function createCommandLinks(options: CreateCommandLinksOptions): void {
  for (const name of options.names) {
    const path = Bun.which(name);

    if (path === null) {
      throw new Error(`${name} is not on PATH`);
    }

    symlinkSync(path, join(options.bin, name));
  }
}
