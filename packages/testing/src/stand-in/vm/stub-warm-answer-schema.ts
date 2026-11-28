import * as z from 'zod';

// what the stub page handler answers impd's warm modes with: the data blocks of a whole-file mode
// (a blocks mode counts the blocks its list marks), and whether the warm runs until it is killed.
// A serving stub marks the blocks `touches` lists in its descriptor 5.
export const StubWarmAnswerSchema = z.object({
  blocks: z.int().nonnegative().default(1),
  hangs: z.boolean().default(false),

  // refuses the block list modes, as a handler built before them does
  refusesBlockLists: z.boolean().default(false),

  // refuses only the warm of blocks, as a handler of the release before the limit does: it counts
  // a record of one byte per block and takes no limit argument
  refusesWarmBlocks: z.boolean().default(false),
  touches: z.array(z.int().nonnegative()).default([]),
});

export type StubWarmAnswer = z.input<typeof StubWarmAnswerSchema>;
