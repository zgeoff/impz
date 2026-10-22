import * as z from 'zod';
import { NameSchema } from './name-schema';

export const LeaseLabelSchema = z
  .string()
  .regex(/^[\w.:-]{1,64}$/u, 'must be 1–64 letters, digits, dots, underscores, colons or hyphens');

export const LeaseTtlSchema = z.int().min(10).max(3600);

/* @internal */
export const LeaseOwnerSchema = z.object({
  principal: z.string(),
  display: z.string(),
  label: z.string(),
});

export const LeaseSchema = z.object({
  name: NameSchema,
  owner: LeaseOwnerSchema,

  until: z.date().nullable(),
});

export const LeaseSummarySchema = z.object({
  leases: z.array(LeaseSchema).readonly(),
  otherCount: z.int().nonnegative(),
});

export type Lease = z.infer<typeof LeaseSchema>;

export type LeaseSummary = z.infer<typeof LeaseSummarySchema>;
