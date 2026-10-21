import type { ImageSource } from '@impz/api';
import type { Selectable } from 'kysely';
import type { ImpDatabase } from './open-database';
import type { DB } from './schema';

export interface ImageRecord {
  readonly id: string;
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly source: ImageSource;

  readonly sourceImp: string | null;
  readonly sizeBytes: number;
  readonly createdAt: Date;
}

export interface NewImage {
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;

  readonly source?: ImageSource;
  readonly sourceImp?: string | null;
}

export async function createImage(db: ImpDatabase, image: NewImage): Promise<ImageRecord> {
  const now = Date.now();

  const row = await db
    .insertInto('images')
    .values({
      id: Bun.randomUUIDv7(),
      name: image.name,
      ref: image.ref,
      digest: image.digest,
      size_bytes: image.sizeBytes,
      source: image.source ?? 'oci',
      source_imp: image.sourceImp ?? null,
      created_at: now,
      last_used_at: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImageRecord(row);
}

export async function readImageByName(
  db: ImpDatabase,
  name: string,
): Promise<ImageRecord | undefined> {
  const row = await db.selectFrom('images').selectAll().where('name', '=', name).executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function readImageByDigest(
  db: ImpDatabase,
  digest: string,
): Promise<ImageRecord | undefined> {
  const row = await db
    .selectFrom('images')
    .selectAll()
    .where('digest', '=', digest)
    .orderBy('created_at')
    .orderBy('id')
    .executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function readImageById(db: ImpDatabase, id: string): Promise<ImageRecord | undefined> {
  const row = await db.selectFrom('images').selectAll().where('id', '=', id).executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function listImages(db: ImpDatabase): Promise<ImageRecord[]> {
  const rows = await db.selectFrom('images').selectAll().orderBy('name').execute();

  return rows.map((row) => toImageRecord(row));
}

// throws on a foreign key while any imp still uses the image
export async function removeImage(db: ImpDatabase, id: string): Promise<boolean> {
  const result = await db.deleteFrom('images').where('id', '=', id).executeTakeFirst();

  return result.numDeletedRows > 0n;
}

function toImageRecord(row: Readonly<Selectable<DB['images']>>): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    ref: row.ref,
    digest: row.digest,
    source: row.source,
    sourceImp: row.source_imp,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at),
  };
}

export async function updateImage(
  db: ImpDatabase,
  id: string,
  image: Readonly<Omit<NewImage, 'name' | 'source'>>,
): Promise<ImageRecord> {
  const row = await db
    .updateTable('images')
    .set({
      ref: image.ref,
      digest: image.digest,
      size_bytes: image.sizeBytes,
      source_imp: image.sourceImp ?? null,
      last_used_at: Date.now(),
    })
    .where('id', '=', id)
    .returningAll()
    .executeTakeFirstOrThrow();

  return toImageRecord(row);
}

export async function countImageDigestUses(db: ImpDatabase, digest: string): Promise<number> {
  const row = await db
    .selectFrom('images')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('digest', '=', digest)
    .executeTakeFirstOrThrow();

  return row.count;
}

export async function updateImageUse(
  db: ImpDatabase,
  imageIDs: readonly string[],
  at: number,
): Promise<void> {
  if (imageIDs.length === 0) {
    return;
  }

  await db
    .updateTable('images')
    .set({ last_used_at: at })
    .where('id', 'in', imageIDs)
    .where('last_used_at', '<', at)
    .execute();
}

export interface ImageUse {
  readonly id: string;
  readonly name: string;
  readonly digest: string;
  readonly source: ImageSource;
  readonly sizeBytes: number;
  readonly lastUsedAt: number;
  readonly impCount: number;
}

export async function listImageUses(db: ImpDatabase): Promise<ImageUse[]> {
  const rows = await db
    .selectFrom('images')
    .leftJoin('imps', 'imps.image_id', 'images.id')
    .select((eb) => [
      'images.id',
      'images.name',
      'images.digest',
      'images.source',
      'images.size_bytes',
      'images.last_used_at',
      eb.fn.count<number>('imps.id').as('imp_count'),
    ])
    .groupBy('images.id')
    .orderBy('images.name')
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    digest: row.digest,
    source: row.source,
    sizeBytes: row.size_bytes,
    lastUsedAt: row.last_used_at,
    impCount: row.imp_count,
  }));
}

export async function removeUnusedImage(
  db: ImpDatabase,
  id: string,
  lastUsedAt: number,
): Promise<boolean> {
  const result = await db
    .deleteFrom('images')
    .where('id', '=', id)
    .where('last_used_at', '=', lastUsedAt)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom('imps').select('imps.id').whereRef('imps.image_id', '=', 'images.id'),
        ),
      ),
    )
    .executeTakeFirst();

  return result.numDeletedRows > 0n;
}
