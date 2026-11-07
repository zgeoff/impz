import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import type { StubWarmAnswer } from './stub-warm-answer-schema';

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

const WarmRunSchema = z.object({
  mode: z.enum(['--count-data', '--warm']),
  memFile: z.string(),
  pid: z.int(),
});

export function createStubUffdHandler(directory: string, mode: StubUffdHandlerMode = 'serve') {
  const path = join(directory, `uffd-handler-${mode}`);
  const recorded = join(directory, `uffd-handler-${mode}.starts`);
  const warmAnswer = join(directory, `uffd-handler-${mode}.warm.json`);
  const script = join(import.meta.dir, 'run-stub-uffd-handler.ts');

  writeFileSync(
    path,
    `#!/bin/sh\nexec '${process.execPath}' '${script}' '${mode}' '${recorded}' '${warmAnswer}' "$@"\n`,
    { mode: 0o755 },
  );

  return {
    path,
    readStarts: (): z.infer<typeof StartSchema>[] => readRecords(recorded, StartSchema),
    readWarmRuns: (): z.infer<typeof WarmRunSchema>[] =>
      readRecords(`${recorded}.warms`, WarmRunSchema),
    answerWarm: (answer: Readonly<StubWarmAnswer>): void => {
      writeFileSync(warmAnswer, JSON.stringify(answer));
    },
  };
}

function readRecords<T>(path: string, schema: z.ZodType<T>): T[] {
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line) => schema.parse(JSON.parse(line)))
    : [];
}
