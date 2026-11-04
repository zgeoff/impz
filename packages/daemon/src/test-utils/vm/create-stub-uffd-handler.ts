import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';

// serve: answers on its socket until killed; crash: exits at its first
// connection, as a handler that dies on a fault; refuse: exits before it binds
type StubUffdHandlerMode = 'serve' | 'crash' | 'refuse';

const StartSchema = z.object({
  options: z.object({
    socket: z.string().optional(),
    uid: z.string().optional(),
    gid: z.string().optional(),
  }),
  served: z.string(),
});

export function createStubUffdHandler(directory: string, mode: StubUffdHandlerMode = 'serve') {
  const path = join(directory, `uffd-handler-${mode}`);
  const recorded = join(directory, `uffd-handler-${mode}.starts`);
  const script = join(import.meta.dir, 'run-stub-uffd-handler.ts');

  writeFileSync(
    path,
    `#!/bin/sh\nexec '${process.execPath}' '${script}' '${mode}' '${recorded}' "$@"\n`,
    { mode: 0o755 },
  );

  return {
    path,
    readStarts: (): z.infer<typeof StartSchema>[] =>
      existsSync(recorded)
        ? readFileSync(recorded, 'utf8')
            .trimEnd()
            .split('\n')
            .map((line) => StartSchema.parse(JSON.parse(line)))
        : [],
  };
}
