import * as z from 'zod';

export const OffsetSchema = z.int().nonnegative();
