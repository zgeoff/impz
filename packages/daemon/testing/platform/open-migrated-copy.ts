import { Database } from 'bun:sqlite';
import { openDatabase } from '../../src/platform/db/open-database';
import type { ImpDatabase } from '../../src/platform/db/open-database';

// the migrations take about 16 ms per database and a copy about 0.1 ms, so a
// test process migrates once
const TEMPLATE: { bytes?: Promise<Buffer> } = {};

export function openMigratedCopy(): Promise<ImpDatabase> {
  TEMPLATE.bytes ??= serializeMigratedDatabase();

  return TEMPLATE.bytes.then((bytes) => openDatabase(Database.deserialize(bytes)));
}

async function serializeMigratedDatabase(): Promise<Buffer> {
  const sqlite = new Database(':memory:');

  const db = await openDatabase(sqlite);

  const bytes = sqlite.serialize();

  await db.destroy();

  return bytes;
}
