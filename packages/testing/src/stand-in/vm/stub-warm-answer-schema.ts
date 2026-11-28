import * as z from 'zod';

// what the stub page handler answers impd's --count-data, --warm, --count-blocks
// and --warm-blocks with: the data blocks it counts or reads, and whether the warm runs until it is killed.
// A serving stub marks the blocks `touches` lists in its descriptor 5.
export const StubWarmAnswerSchema = z.object({
  blocks: z.int().nonnegative().default(1),
  hangs: z.boolean().default(false),
  touches: z.array(z.int().nonnegative()).default([]),
});

export type StubWarmAnswer = z.input<typeof StubWarmAnswerSchema>;
