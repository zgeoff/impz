import type { ImpDatabase } from './open-database';
import type { SecretRow } from './secrets';

// A backup's secret rows with their generation and value file, so grantable
// lists still name them and a replace keeps both. A name this host has keeps
// its own row. Returns the names written.
export function createRestoredSecrets(
  db: ImpDatabase,
  rows: readonly SecretRow[],
): Promise<string[]> {
  return db.transaction().execute(async (trx) => {
    const written: string[] = [];

    for (const row of rows) {
      const inserted = await trx
        .insertInto('secrets')
        .values(row)
        .onConflict((conflict) => conflict.column('name').doNothing())
        .returning('name')
        .executeTakeFirst();

      if (inserted !== undefined) {
        written.push(inserted.name);
      }
    }

    return written;
  });
}
