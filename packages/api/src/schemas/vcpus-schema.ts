import * as z from 'zod';

export const VcpusSchema = z.int().min(1).max(32);
