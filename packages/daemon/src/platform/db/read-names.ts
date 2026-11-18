import * as z from 'zod';

const NameRowsSchema = z.array(z.object({ name: z.string() }));

// the names in the rows of a query that selects a name column
export function readNames(rows: unknown): string[] {
  return NameRowsSchema.parse(rows).map((row) => row.name);
}
