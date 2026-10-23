import * as z from 'zod';
import { EmptySchema } from '../schemas/empty-schema';
import { ACCESS } from './access';
import { contractBase as base } from './contract-base';

// impd answers these with no caller: a login sets the dashboard's session
// cookie, and a logout clears it.
export const authContract = {
  login: base
    .meta(ACCESS.noSession)
    .errors({ UNAUTHORIZED: { message: 'The token authenticates nobody' } })
    .input(z.object({ token: z.string() }))
    .output(EmptySchema),

  logout: base.meta(ACCESS.noSession).output(EmptySchema),
};
