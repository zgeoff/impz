import type { ImageSource } from '@impz/api';
import type { Selectable } from 'kysely';
import { buildConflictError } from '../errors/build-not-found-error';
import type { DB } from './db';
import type { ImpDatabase, ImpQueries } from './open-database';

export interface ImageRecord {
  readonly id: string;
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly receivedDigest: string | null;
  readonly source: ImageSource;

  readonly sourceImp: string | null;
  readonly sizeBytes: number;
  readonly createdAt: Date;
  readonly isPinned: boolean;
}

export interface NewImage {
  readonly name: string;
  readonly ref: string;
  readonly digest: string;
  readonly sizeBytes: number;

  readonly source?: ImageSource;
  readonly sourceImp?: string | null;
}

export async function createImage(
  db: ImpDatabase,
  image: NewImage,
  now: number = Date.now(),
): Promise<ImageRecord> {
  // the alias check and the insert share a transaction, so an alias set during a long build
  // makes the build's write answer a conflict
  const row = await db.transaction().execute(async (trx) => {
    const alias = await trx
      .selectFrom('image_aliases')
      .select('name')
      .where('name', '=', image.name)
      .executeTakeFirst();

    if (alias !== undefined) {
      throw buildConflictError(
        'image',
        image.name,
        `image name ${image.name} is held by an alias; remove the alias first`,
      );
    }

    return trx
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
  });

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
  digests: readonly string[],
): Promise<ImageRecord | undefined> {
  const row = await db
    .selectFrom('images')
    .selectAll()
    .where((eb) => eb.or([eb('digest', 'in', digests), eb('received_digest', 'in', digests)]))
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

// throws on a foreign key while any imp or alias still uses the image
export function removeImage(db: ImpDatabase, id: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom('images')
      .where('id', '=', id)
      .returning('digest')
      .executeTakeFirst();

    if (row === undefined) {
      return false;
    }

    await createImageRemoval(trx, row.digest);

    return true;
  });
}

export function toImageRecord(row: Readonly<Selectable<DB['images']>>): ImageRecord {
  return {
    id: row.id,
    name: row.name,
    ref: row.ref,
    digest: row.digest,
    receivedDigest: row.received_digest,
    source: row.source,
    sourceImp: row.source_imp,
    sizeBytes: row.size_bytes,
    createdAt: new Date(row.created_at),
    isPinned: row.pinned === 1,
  };
}

export async function updateImagePin(
  db: ImpDatabase,
  name: string,
  isPinned: boolean,
  refPrefix: string | null = null,
): Promise<ImageRecord | undefined> {
  const update = db
    .updateTable('images')
    .set({ pinned: isPinned ? 1 : 0 })
    .where('name', '=', name);

  // substr, not LIKE, so a % or _ in the prefix matches only itself
  const scoped =
    refPrefix === null
      ? update
      : update.where((eb) =>
          eb(eb.fn<string>('substr', ['ref', eb.val(1), eb.val(refPrefix.length)]), '=', refPrefix),
        );

  const row = await scoped.returningAll().executeTakeFirst();

  return row === undefined ? undefined : toImageRecord(row);
}

export async function updateImage(
  db: ImpDatabase,
  id: string,
  image: Readonly<Omit<NewImage, 'name' | 'source'>>,
  now: number = Date.now(),
): Promise<ImageRecord> {
  const row = await db
    .updateTable('images')
    .set({
      ref: image.ref,
      digest: image.digest,
      received_digest: null,
      size_bytes: image.sizeBytes,
      source_imp: image.sourceImp ?? null,
      last_used_at: now,
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
  column: 'id' | 'name' | 'digest',
  values: readonly string[],
  at: number,
): Promise<void> {
  if (values.length === 0) {
    return;
  }

  await db
    .updateTable('images')
    .set({ last_used_at: at })
    .where((eb) =>
      column === 'digest'
        ? eb.or([eb('digest', 'in', values), eb('received_digest', 'in', values)])
        : eb(column, 'in', values),
    )
    .where('last_used_at', '<', at)
    .execute();
}

export async function updateImageReceivedDigest(
  db: ImpDatabase,
  image: Readonly<Pick<ImageRecord, 'id' | 'digest'>>,
  receivedDigest: string,
): Promise<void> {
  await db
    .updateTable('images')
    .set({ received_digest: receivedDigest })
    .where('id', '=', image.id)
    .where('digest', '=', image.digest)
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
  readonly isPinned: boolean;
  readonly isAliased: boolean;
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
      'images.pinned',
      eb.fn.count<number>('imps.id').as('imp_count'),
      eb
        .exists(
          eb
            .selectFrom('image_aliases')
            .select('image_aliases.name')
            .whereRef('image_aliases.image_id', '=', 'images.id'),
        )
        .as('is_aliased'),
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
    isPinned: row.pinned === 1,
    isAliased: Boolean(row.is_aliased),
  }));
}

export function removeUnusedImage(
  db: ImpDatabase,
  id: string,
  lastUsedAt: number,
): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .deleteFrom('images')
      .where('id', '=', id)
      .where('last_used_at', '=', lastUsedAt)
      .where('pinned', '=', 0)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb.selectFrom('imps').select('imps.id').whereRef('imps.image_id', '=', 'images.id'),
          ),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('image_aliases')
              .select('image_aliases.name')
              .whereRef('image_aliases.image_id', '=', 'images.id'),
          ),
        ),
      )
      .returning('digest')
      .executeTakeFirst();

    if (row === undefined) {
      return false;
    }

    await createImageRemoval(trx, row.digest);

    return true;
  });
}

async function createImageRemoval(db: ImpQueries, digest: string): Promise<void> {
  await db
    .insertInto('image_removals')
    .values({ digest, created_at: Date.now() })
    .onConflict((conflict) => conflict.column('digest').doNothing())
    .execute();
}

export async function listImageRemovals(db: ImpDatabase): Promise<string[]> {
  const rows = await db.selectFrom('image_removals').select('digest').orderBy('digest').execute();

  return rows.map((row) => row.digest);
}

export async function removeImageRemoval(db: ImpDatabase, digest: string): Promise<void> {
  await db.deleteFrom('image_removals').where('digest', '=', digest).execute();
}
