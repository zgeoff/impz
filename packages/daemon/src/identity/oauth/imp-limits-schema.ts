import { GrantPatternSchema } from '@impz/api';
import * as z from 'zod';

// imps: the patterns a grant may reach, null for every imp; grantable: whether the imp token that
// approved the grant could grant secrets when impd moved its grants to the shared OAuth server
export const ImpLimitsSchema = z.object({
  imps: z.array(GrantPatternSchema).min(1).max(32).nullable(),
  grantable: z.boolean(),
});

export type ImpLimits = z.infer<typeof ImpLimitsSchema>;
