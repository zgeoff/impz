import { faker } from '@faker-js/faker';
import { EgressPolicySchema, NameSchema } from '@impz/api';
import { Collection } from '@msw/data';
import * as z from 'zod';

const ImpPolicyRowSchema = z.object({
  imp: NameSchema.default(() => faker.string.alpha({ length: 8, casing: 'lower' })),
  policy: EgressPolicySchema.default(() => ({ mode: 'open' as const, allow: [] })),
});

export const impPolicyCollection = new Collection({ schema: ImpPolicyRowSchema });
