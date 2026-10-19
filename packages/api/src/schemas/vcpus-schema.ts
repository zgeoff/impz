import * as z from 'zod';

// the guest's cores, which the host's limit then shares out
export const VcpusSchema = z.int().min(1).max(32);
