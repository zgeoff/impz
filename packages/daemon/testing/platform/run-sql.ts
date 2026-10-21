import { CompiledQuery } from 'kysely';
import type { ImpQueries } from '../../src/platform/db/open-database';

export async function runSql(
  db: ImpQueries,
  text: string,
  parameters: readonly unknown[] = [],
): Promise<unknown[]> {
  const result = await db.executeQuery(CompiledQuery.raw(text, [...parameters]));

  return result.rows;
}
