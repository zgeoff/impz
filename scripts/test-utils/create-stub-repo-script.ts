import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createStubRepoScript(
  scripts: string,
  name: string,
  calls: string,
  body = '',
): string {
  const file = join(scripts, name);

  writeFileSync(
    file,
    `#!/bin/bash\nprintf '%s\\n' "${name} $*" >>'${calls.replaceAll("'", String.raw`'\''`)}'\n${body}\n`,
  );

  chmodSync(file, 0o755);

  return file;
}
