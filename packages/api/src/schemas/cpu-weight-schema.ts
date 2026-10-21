import * as z from 'zod';

// The range of cgroup v2's cpu.weight, whose default share is 100.
export const CpuWeightSchema = z.int().min(1).max(10_000);
