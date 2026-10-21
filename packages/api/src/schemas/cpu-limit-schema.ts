import * as z from 'zod';

// Below 0.1 cores the VMM thread starves and a boot times out.
export const CpuLimitSchema = z.number().min(0.1);
