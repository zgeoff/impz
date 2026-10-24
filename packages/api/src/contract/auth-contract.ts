import * as z from 'zod';
import { EmptySchema } from '../schemas/empty-schema';
import { ACCESS } from './access';
import { contractBase as base } from './contract-base';

export const authContract = {
  login: base
    .meta(ACCESS.noSession)
    .errors({ UNAUTHORIZED: { message: 'The token authenticates nobody' } })
    .input(z.object({ token: z.string() }))
    .output(EmptySchema),

  logout: base.meta(ACCESS.noSession).output(EmptySchema),
};
