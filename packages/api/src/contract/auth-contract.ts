import { oc } from '@orpc/contract';
import * as z from 'zod';
import { EmptySchema } from '../schemas/empty-schema';
import { IMP_ERRORS } from './imp-errors';

const base = oc.errors(IMP_ERRORS);

// impd answers these with no caller: a login sets the dashboard's session
// cookie, and a logout clears it.
export const authContract = {
  login: base
    .errors({ UNAUTHORIZED: { message: 'The token authenticates nobody' } })
    .input(z.object({ token: z.string() }))
    .output(EmptySchema),

  logout: base.output(EmptySchema),
};
