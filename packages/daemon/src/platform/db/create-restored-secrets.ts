import type { ImpDatabase } from './open-database';
import type { SecretRow } from './secrets';

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
