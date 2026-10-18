import * as z from 'zod';

// cgroup v2 cpu.weight; 100 is the default share
export const CpuWeightSchema = z.int().min(1).max(10_000);
