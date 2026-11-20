import * as z from 'zod';

// what the stub page handler answers impd's --count-data and --warm with: the
// memory file's data blocks, and whether the warm runs until it is killed
export const StubWarmAnswerSchema = z.object({
  blocks: z.int().nonnegative().default(1),
  hangs: z.boolean().default(false),
});

export type StubWarmAnswer = z.input<typeof StubWarmAnswerSchema>;
