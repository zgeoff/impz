import * as z from 'zod';

export const ChangedPagesReportSchema = z.object({
  changedMib: z.number(),
  changedHugeMib: z.number(),
});

export type ChangedPagesReport = z.infer<typeof ChangedPagesReportSchema>;
