import { faker } from '@faker-js/faker';
import { CheckpointSchema, NameSchema } from '@impz/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const CHECKPOINT_ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

const CheckpointRowSchema = CheckpointSchema.extend({
  imp: NameSchema.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),

  // impd's checkpoint id format, copied because impd's own id builder imports
  // modules the browser cannot load
  id: z.string().default(() => `cp-${faker.string.fromCharacters(CHECKPOINT_ID_ALPHABET, 6)}`),
  createdAt: z.date().default(() => faker.date.past()),
  diskMib: z
    .int()
    .positive()
    .default(() => faker.number.int({ min: 1, max: 64 }) * 1024),
});

export const checkpointCollection = new Collection({ schema: CheckpointRowSchema });
