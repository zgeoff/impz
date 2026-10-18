import * as z from 'zod';

// cores; below 0.1 the VMM thread starves and a boot times out. impd also
// refuses more than the host has.
export const CpuLimitSchema = z.number().min(0.1);
