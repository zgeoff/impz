import * as z from 'zod';

export const ImpsSchema = z.array(z.string()).nullable();
